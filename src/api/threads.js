/*
 * Tesla api methods for accessing and manipulating thread data
 */
var _ = require('underscore'),
    queryBuilder = require('./queryBuilder'),
    comments = require('./comments'),
    users = require('./users');

function summaryMapping(thread){
    return {
        _id: thread._id,
        created: thread.created,
        last_comment_by: thread.last_comment_by,
        last_comment_time: thread.last_comment_time,
        name: thread.name,
        urlname: thread.urlname,
        postedby: thread.postedby,
        numcomments: thread.numcomments,
        deleted: thread.deleted,
        closed: thread.closed,
        nsfw: thread.nsfw,
        categories: thread.categories
    };
}

module.exports = function(db){
    var commentsApi = comments(db),
        usersApi = users(db);

    return {
        getThreads: function(options, done){
            queryBuilder.buildOptions('read:threads', options, function(err, cleanOptions){
                if(err){
                    return done(err);
                }

                var totaldocs,
                    query = db.thread.find(cleanOptions.query);

                if(cleanOptions.countonly){
                    query.count(function (err, count) {
                        if (err) return done(err);
                        
                        done(null, {
                            totaldocs: count
                        });
                    });
                    return;
                }

                _(query).clone().count(function (err, count) {
                    if (err) return done(err);
                    totaldocs = count;
                });

                if(cleanOptions.sortBy){
                    query.sort(cleanOptions.sortBy);
                }
                if(cleanOptions.skip){
                    query.skip(cleanOptions.skip);
                }
                if(cleanOptions.limit){
                    query.limit(cleanOptions.limit);
                }

                // population only below here
                if(cleanOptions.populate){
                    query.populate('comments');
                }

                query.exec(function(err, threads){
                    if(err){
                        return done(err);
                    }
                    if(!threads || !threads.length){
                        return done(null, []);
                    }
                    if(cleanOptions.summary){
                        threads = _(threads).map(summaryMapping);
                    }

                    done(null,
                        {
                            threads: threads,
                            skip: cleanOptions.skip,
                            limit: cleanOptions.limit,
                            totaldocs: totaldocs
                        }
                    );
                });
            });
        },

        // retrieves a single document, sorting is disabled, and paging is applied to the comments
        getThread: function(options, done){
            queryBuilder.buildOptions('read:threads', options, function(err, cleanOptions){
                if(err){
                    return done(err);
                }

                var totaldocs = 0,
                    query = db.thread
                    .find(cleanOptions.query) //findOne not working here?
                    .limit(1);

                _(query).clone().exec(function(err, threads){
                    if(err) return done(err);
                    if(!threads || !threads.length){
                        return done(null, []);
                    }

                    totaldocs = threads[0].comments.length;

                    if(cleanOptions.skip || cleanOptions.limit){
                        query.slice('comments', [cleanOptions.skip || 0, cleanOptions.limit]);
                    }

                    // population only below here
                    if(cleanOptions.populate){
                        query.populate('comments');
                    }

                    query.exec(function(err, threads){
                        if(err) return done(err);

                        if(cleanOptions.summary){
                            threads = _(threads).map(summaryMapping);
                        }

                        done(null,
                            {
                                threads: threads,
                                skip: cleanOptions.skip,
                                limit: cleanOptions.limit,
                                totaldocs: totaldocs
                            });
                    });
                });
            });
        },

        getThreadsInUserList: function(options, done){
            var that = this, // following vars to getThreads only - do not apply to getUser
                summary = !!options.summary,
                populate = !!options.populate,
                excludelist = !!options.excludelist,
                threadquery = options.threadquery,
                sortBy = options.sortBy;

            delete options.summary;
            delete options.populate;
            delete options.excludelist;
            delete options.sortBy;

            usersApi.getUser(options, function(err, user){
                if(err) return done(err);
                if(!user) return done(new Error('user not found'));

                var idClause = { $in: user[options.listkey] };

                if(excludelist){
                    idClause = { $nin: user[options.listkey] };
                }

                return that.getThreads({
                    query: _(threadquery || {}).extend({
                        _id: idClause
                    }),
                    page: options.page,
                    size: options.size,
                    summary: summary,
                    populate: populate,
                    sortBy: sortBy
                }, done);
            });
        },

        postThread: function(options, done){
            var that = this;

            usersApi.getUser({
                query: {
                    username: options.query.postedby
                }
            }, function(err, user){
                if(err) return done(err);

                queryBuilder.buildOptions('write:threads', options, function(err, cleanOptions){
                    if(err){
                        return done(err);
                    }

                    var thread = new db.thread(cleanOptions.query);

                    if(!thread){
                        return done(new Error('could not create thread'));
                    }

                    user.threads_count = (user.threads_count || 0) + 1;
                    user.save();

                    return that.postCommentInThreadByUser({
                        query: {
                            postedby: options.query.postedby,
                            content: options.query.content
                        },
                        user: user,
                        thread: thread,
                        returnthread: true
                    }, done);
                });
                
            });
        },

        postCommentInThreadByUser: function(options, done){
            options = options || {};
            if(!options.thread){
                done(new Error('thread is required'));
            }
            if(!options.user){
                done(new Error('user is required'));
            }
            
            var thread = options.thread,
                user = options.user;

            queryBuilder.buildOptions('write:comments', options, function(err, cleanOptions){
                if(err){
                    return done(err);
                }

                commentsApi.postComment({
                    query: {
                        postedby: cleanOptions.query.postedby,
                        content: cleanOptions.query.content
                    }
                }, function(err, comment){
                    if(err){
                        return done(err);
                    }

                    thread.last_comment_by = cleanOptions.query.postedby;
                    thread.last_comment_time = new Date();
                    thread.comments.push(comment._id);
                    thread.numcomments = (thread.numcomments || 0) + 1;

                    if(user.participated.indexOf(thread._id) === -1){
                        user.participated.push(thread._id);
                    }

                    user.comments_count = (user.comments_count || 0) + 1;
                    user.save();

                    thread.save(function(err){
                        if(err) return done(err);

                        return done(null, options.returnthread ? thread : comment);
                    });
                });
            });
        },

        postComment: function(options, done){
            var thread,
                that = this;

            usersApi.getUser({
                query: {
                    username: options.query.postedby
                }
            }, function(err, user){
                if(err) return done(err);
                
                that.getThread({
                    query: {
                        _id: options.query.threadid
                    }
                }, function(err, json){
                    if(err){
                        return done(err);
                    }

                    if(!json.threads || !json.threads.length){
                        return done(new Error('thread not found'));
                    }
                    thread = json.threads[0];

                    return that.postCommentInThreadByUser({
                        query: {
                            postedby: options.query.postedby,
                            content: options.query.content
                        },
                        user: user,
                        thread: thread
                    }, done);
                });
            });
        }
    };
};