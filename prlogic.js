var config = require('./config');
var github = require('./github');
var gerrit = require('./gerrit');
var git = require('gift');
var rimraf = require('rimraf');
var scp = require('scp');
var path = require('path');
var crypto = require('crypto');
var fs = require('fs');
var ejs = require('ejs');

function ejsCompile(file) {
  var filename = path.join(__dirname, 'tpls', file);
  return ejs.compile(fs.readFileSync(filename, 'utf8'), {filename: filename});
}

var noclaTpl = ejsCompile('no_cla.ejs');
var tooManyCommitsTpl = ejsCompile('too_many_commits.ejs');
var changeCreatedTpl = ejsCompile('change_created.ejs');
var changePushedTpl = ejsCompile('change_pushed.ejs');
var closedTpl = ejsCompile('change_closed.ejs');
var timeoutTpl = ejsCompile('timeout.ejs');

function setupRepoDir(callback) {
  rimraf('repos', function(err) {
    if (err) return callback(err);
    fs.mkdir('repos', function(err) {
      if (err) return callback(err);
      callback();
    })
  });
}
setupRepoDir(function(err) {
  if (err) throw err;
});

var GERRIT_PR_BOT_TAG = '::SDKBOT/PR';
var GITHUB_PR_BOT_TAG = '::SDKBOT/PR';

function getRepoProject(opts) {
  for (var i in config.projects) {
    if (config.projects[i] === opts.user + '/' + opts.repo) {
      return i;
    }
  }
  return null;
}

/*
opts
  user
  repo
  number
 */
function getChangeNumFromPr(opts, callback) {
  github.issues.getComments({
    user: opts.user,
    repo: opts.repo,
    number: opts.number,
    per_page: 100
  }, function(err, comments) {
    if (err) return callback(err);

    var info = null;
    for (var i = 0; i < comments.length; ++i) {
      if (comments[i].user.login != config.github.user) {
        // Don't parse comments not made by myself
        continue;
      }

      var msg = comments[i].body;
      if (msg.indexOf(GITHUB_PR_BOT_TAG) !== -1) {
        var csUriMatch = msg.match(/review.couchbase.org\/#\/c\/([0-9]*)/);
        if (csUriMatch) {
          if (!info) {
            info = {};
          }
          info.changeNum = csUriMatch[1];
        }

        var prTagIdx = msg.indexOf(GITHUB_PR_BOT_TAG + ':');
        if (prTagIdx !== -1) {
          if (!info) {
            info = {};
          }
          var tagData = msg.substr(prTagIdx + GITHUB_PR_BOT_TAG.length + 1);
          var matches = tagData.match(/[a-zA-Z0-9_\-]*/);
          if (matches) {
            var foundStatus = GH_STATUS_TAGS[matches[0]];
            if (foundStatus) {
              info.status = foundStatus;
            }

            // To help with debugging and what not...
            if (matches[0] === 'reset') {
              info.status = GH_STATUS.NEW;
            }
          }
        }
      }
    }

    if (info && !info.status) {
      info.status = 0;
    }

    callback(null, info);
  });
}

function getBotPrChangeId(changeId, callback) {
  gerrit.getChangeDetails(changeId, function(err, change) {
    if (err) return callback(err);

    var info = null;
    for (var j = 0; j < change.messages.length; ++j) {
      var msg = change.messages[j].message;
      if (msg.indexOf(GERRIT_PR_BOT_TAG) !== -1) {
        var ghUriMatch = msg.match(/github.com\/([^\/]*)\/([^\/]*)\/pull\/([0-9]*)/);
        if (ghUriMatch) {
          info = {
            user: ghUriMatch[1],
            repo: ghUriMatch[2],
            number: parseInt(ghUriMatch[3]),
            status: change.status
          };
        }
      }
    }

    return callback(null, info);
  });
}

function findPrChangeId(opts, callback) {
  var ghUri = 'github.com/' + opts.user + '/' + opts.repo + '/pull/' + opts.number;
  console.log('searching pr by', opts.project, ghUri);
  gerrit.queryChanges('project:' + opts.project + ' ' + ghUri, function(err, changes) {
    if (err) return callback(err);

    var remain = changes.length;
    var changeIds = [];
    var openChangeIds = [];
    if (remain === 0) {
      return callback(null, null);
    }

    for (var i = 0; i < changes.length; ++i) {
      (function(i) {
        var changeId = changes[i].change_id;

        getBotPrChangeId(changeId, function(err, info) {
          if (err) {
            remain = -1;
            return callback(new Error('could not load pr search changesets'));
          }

          console.log('checking', changeId, info);

          if (info &&
              info.user == opts.user &&
              info.repo == opts.repo &&
              info.number == opts.number) {
            changeIds.push(changeId);

            if (info.status !== 'ABANDONED') {
              openChangeIds.push(changeId);
            }
          }

          remain--;
          if (remain == 0) {
            console.log('found', changeIds, openChangeIds);
            if (changeIds.length == 0) {
              return callback(null, null);
            } else if (changeIds.length > 0) {
              if (openChangeIds.length === 0) {
                return callback(new Error('all_changes_closed'));
              } else if (openChangeIds.length === 1) {
                return callback(null, openChangeIds[0]);
              } else {
                return callback(new Error('too_many_changes'));
              }
            }
          }
        });
      })(i);
    }
  });
}

/*
opts
  project
  clone_url
  ref
  target
 */
function cloneProjectFromGithub(opts, callback) {
  git.clone(opts.clone_url, opts.target, function(err, repo) {
    if (err) return callback(err);

    repo.checkout(opts.ref, function (err) {
      if (err) return callback(err);

      scp.get({
        file: 'hooks/commit-msg',
        user: config.gerrit.user,
        host: config.gerrit.host,
        port: config.gerrit.gitport,
        path: path.join(opts.target, '.git/hooks')
      }, function (err) {
        if (err) return callback(err);

        var gerritUri =
            'ssh://' +
            config.gerrit.user + '@' +
            config.gerrit.host + ':' + config.gerrit.gitport +
                '/' + opts.project;
        repo.remote_add('gerrit', gerritUri, function (err) {
          if (err) return callback(err);

          callback(null, repo);
        });
      });
    });
  });
}


function updateChangeId(repo, oldChangeId, callback) {
  repo.current_commit(function (err, commit) {
    if (err) return callback(err);

    var new_message = commit.message;
    if (oldChangeId) {
      new_message += '\n\nChange-Id: ' + oldChangeId;
    }

    repo.commit(new_message, {amend: true}, function (err) {
      if (err) return callback(err);

      repo.current_commit(function (err, commit) {
        var changeIdMatch = commit.message.match('Change-Id: ([a-zA-Z0-9]*)');
        var changeId = '';
        if (changeIdMatch && changeIdMatch[1]) {
          changeId = changeIdMatch[1];
        }

        if (!changeId) {
          return callback(new Error('failed to generate a changeid'));
        }

        callback(null, changeId);
      });
    });
  });
}

/*
 opts
 project
 user
 repo
 number
 changeId
 */
function maybeTagChangeset(opts, callback) {
  var changeKey = opts.project + '~master~' + opts.changeId;
  console.log('getting pr changeid for', changeKey);
  getBotPrChangeId(changeKey, function(err, info) {
    if (err) return callback(err);
    console.log('done', info);

    if (info && info.user === opts.user && info.repo === opts.repo && info.number === opts.number) {
      console.log('skipping bot tag, already there');
      return callback();
    }

    var ghUri = 'https://github.com/' + opts.user + '/' + opts.repo + '/pull/' + opts.number;
    console.log('posting gerrit changeset tag for', ghUri);
    gerrit.postChangeReview(changeKey, 'current', {
      message: 'Change-Set generated from ' + ghUri + '.' + '\n' + GERRIT_PR_BOT_TAG
    }, function(err) {
      if (err) return callback(err);
      console.log('done');

      callback();
    });
  });
}

function getGerritRevision(changeId, callback) {
  if (!changeId) {
    console.log('skipping gerrit revision due to blank changeId');
    return callback();
  }

  console.log('downloading gerrit revision data', changeId);
  gerrit.getChangeRevision(changeId, 'current', function(err, body) {
    if (err) return callback(err);
    console.log('got', body.current_revision);

    return callback(null, body.current_revision);
  })
}

function maybeDisableMerge(opts, callback) {
  //disabled
  console.log('merge status writing is disabled in bot');
  return callback();

  console.log('preparing to write merge status');
  github.statuses.get({
    user: opts.user,
    repo: opts.repo,
    sha: opts.sha
  }, function(err, statuses) {
    if (err) return callback(err);

    var foundStatus = false;
    for (var i = 0; i < statuses.length; ++i) {
      if (statuses[i].context === 'cladisable') {
        foundStatus = true;
        break;
      }
    }

    if (foundStatus) {
      console.log('skipping status, already found');
      return callback();
    }

    console.log('creating pending merge status');
    github.statuses.create({
      user: opts.user,
      repo: opts.repo,
      sha: opts.sha,
      state: 'pending',
      target_url: 'http://' + config.gerrit.host,
      description: 'Merge disabled for Code Review',
      context: 'cladisable'
    }, function(err) {
      if (err) return callback(err);
      console.log('done');

      callback();
    });
  });
}

function buildChangesetFromPr(opts, callback) {
  var project = getRepoProject(opts);
  if (!project) {
    return callback(new Error('failed to identify project for ' + opts.user + '/' + opts.repo));
  }

  var randKey = crypto.randomBytes(4).toString('hex');
  var targetDir = path.join('repos', project + '_' + randKey);

  console.log('searching for change-id');
  findPrChangeId({
    user: opts.user,
    repo: opts.repo,
    number: opts.number,
    project: project
  }, function(err, oldChangeId) {
    if (err) return callback(err);
    console.log('found', oldChangeId);

    console.log('retrieving PR data from github');
    github.pullRequests.get({
      user: opts.user,
      repo: opts.repo,
      number: opts.number
    }, function(err, res) {
      if (err) return callback(err);
      console.log('done');

      console.log('disabling merge with status api');
      maybeDisableMerge({
        user: res.base.user.login,
        repo: res.base.repo.name,
        sha: res.head.sha
      }, function(err) {

        // Double check to make sure
        if (res.commits != 1) {
          return callback(new Error('pull requests must have 1 commit to be processed'));
        }

        console.log('cloning repo from github');
        cloneProjectFromGithub({
          project: getRepoProject(opts),
          clone_url: res.head.repo.clone_url,
          ref: res.head.ref,
          target: targetDir
        }, function(err, repo) {
          if (err) return callback(err);
          console.log('done');

          console.log('update changeId using', oldChangeId);
          updateChangeId(repo, oldChangeId, function (err, changeId) {
            if (err) return callback(err);
            console.log('done with', changeId);

            console.log('downloading gerrit revision data');
            getGerritRevision(oldChangeId, function (err, oldRevisionId) {
              if (err) return callback(err);

              console.log('pushing to gerrit');
              repo.remote_push('gerrit', res.head.ref + ':refs/for/master', function (err) {
                // ignore push errors... (since an identical push causes an error)

                rimraf(targetDir, function (err) {
                  if (err) {
                    console.error(err.stack);
                  }
                });

                console.log('maybe tagging changeset');
                maybeTagChangeset({
                  project: project,
                  user: opts.user,
                  repo: opts.repo,
                  number: opts.number,
                  changeId: changeId
                }, function (err) {
                  if (err) return callback(err);
                  console.log('done');

                  if (!oldRevisionId) {
                    return callback(null, 'new', changeId);
                  }

                  getGerritRevision(changeId, function (err, newRevisionId) {
                    if (err) return callback(err);

                    if (newRevisionId == oldRevisionId) {
                      return callback(null, 'no_changes', changeId);
                    }

                    callback(null, 'updated', changeId);
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

function verifyAuthorCla(email, callback) {
  gerrit.getAccountGroups(email, function(err, groups) {
    if (err && err.message.match(/not_found/)) {
      return callback(null, 'not_registered');
    }
    if (err) return callback(err);

    for (var i = 0; i < groups.length; ++i) {
      if (groups[i].id == config.gerrit.cla_groupid) {
        return callback(null, 'signed');
      }
    }

    callback(null, 'registered');
  });
}

/*
 opts
 user
 repo
 number
 */
function getPrAuthorClaStatuses(opts, callback) {
  github.pullRequests.getCommits({
    user: opts.user,
    repo: opts.repo,
    number: opts.number
  }, function(err, commits) {
    if (err) return callback(err);

    var authors_map = {};
    for (var i = 0; i < commits.length; ++i) {
      var author = commits[i].commit.author;

      if (!authors_map[author.email]) {
        authors_map[author.email] = {
          name: author.name,
          email: author.email,
          commits: [],
          status: 'unknown'
        };
      }

      authors_map[author.email].commits.push(commits[i].sha);
    }

    var authors = [];
    for (var i in authors_map) {
      if (authors_map.hasOwnProperty(i)) {
        authors.push(authors_map[i]);
      }
    }

    var remain = authors.length;
    if (remain == 0) {
      return callback(new Error('no authors found'));
    }

    for (var i = 0; i < authors.length; ++i) {
      (function(i) {
        verifyAuthorCla(authors[i].email, function(err, claStatus) {
          if (!err) {
            authors[i].status = claStatus;
          }

          remain--;
          if (remain == 0) {
            return callback(null, authors);
          }
        });
      })(i);
    }
  });
}

var GH_STATUS = {
  NEW: 0,
  TOO_MANY_COMMITS: 1,
  NO_GERRIT_CLA: 2,
  GERRIT_CREATED: 3,
  GERRIT_PUSHED: 4,
  GERRIT_CLOSED: 5,
  TIMEOUT: 6,
  NO_CHANGES: 100
};

// So we can have ordered comparison
var GH_STATUS_TAGS = {
  'new': GH_STATUS.NEW,
  'too_many_commits': GH_STATUS.TOO_MANY_COMMITS,
  'no_cla': GH_STATUS.NO_GERRIT_CLA,
  'created': GH_STATUS.GERRIT_CREATED,
  'pushed': GH_STATUS.GERRIT_PUSHED,
  'closed': GH_STATUS.GERRIT_CLOSED,
  'timeout': GH_STATUS.TIMEOUT,

  'no_changes': GH_STATUS.NO_CHANGES
};
function getGhStatusTag(code) {
  for (var i in GH_STATUS_TAGS) {
    if (GH_STATUS_TAGS[i] === code) {
      return i;
    }
  }
  return 'unknown';
}

/*
opts
  project
  user
  repo
  number
  changeId?
  oldStatus
  newStatus
*/
function maybeTagPullRequest(opts, callback) {
  if (opts.newStatus === GH_STATUS.NO_CHANGES) {
    return callback(null, GH_STATUS.NO_CHANGES);
  }

  if (opts.newStatus === GH_STATUS.GERRIT_CREATED || opts.newStatus === GH_STATUS.GERRIT_PUSHED) {
    return tagPrPushed(opts, callback);
  }

  if (opts.oldStatus === opts.newStatus) {
    return callback(null, GH_STATUS.NO_CHANGES);
  }

  if (opts.newStatus === GH_STATUS.TOO_MANY_COMMITS && opts.oldStatus < opts.newStatus) {
    return tagPrTooManyCommits(opts, callback);
  }

  if (opts.newStatus === GH_STATUS.NO_GERRIT_CLA && opts.oldStatus < opts.newStatus) {
    return tagPrNoCla(opts, callback);
  }

  if (opts.newStatus === GH_STATUS.GERRIT_CLOSED && opts.oldStatus < opts.newStatus) {
    return tagPrClosed(opts, callback);
  }

  if (opts.newStatus === GH_STATUS.TIMEOUT && opts.oldStatus < opts.newStatus) {
    return tagPrTimeout(opts, callback);
  }

  console.error('unexpected pull request state change', opts.oldStatus, opts.newStatus);
  callback();
}
function tagPr(opts, tpl, data, callback) {
  data.first_msg = opts.oldStatus === GH_STATUS.NEW;
  var msg = tpl(data);
  msg += '\n' + GITHUB_PR_BOT_TAG + ':' + getGhStatusTag(opts.newStatus);

  console.log('posting github message for', opts.newStatus, 'from', opts.oldStatus);
  github.issues.createComment({
    user: opts.user,
    repo: opts.repo,
    number: opts.number,
    body: msg
  }, function(err) {
    if (err) return callback(err);
    console.log('done');

    callback(null, opts.newStatus);
  });
}
function tagPrTooManyCommits(opts, callback) {
  tagPr(opts, tooManyCommitsTpl, {

  }, callback);
}
function tagPrNoCla(opts, callback) {
  tagPr(opts, noclaTpl, {

  }, callback);
}
function tagPrPushed(opts, callback) {
  var changeKey = opts.project + '~master~' + opts.changeId;
  console.log('getting changeid change nummber for', changeKey);
  gerrit.getChange(changeKey, function(err, change) {
    if (err) return callback(err);
    console.log('done');

    var csUri = 'http://review.couchbase.org/#/c/' + change._number;
    if (opts.newStatus === GH_STATUS.GERRIT_CREATED) {
      tagPr(opts, changeCreatedTpl, {
        csUri: csUri,
        commitSha: opts.commitSha
      }, callback);
    } else {
      tagPr(opts, changePushedTpl, {
        csUri: csUri,
        commitSha: opts.commitSha
      }, callback);
    }
  });
}
function tagPrClosed(opts, callback) {
  tagPr(opts, closedTpl, {

  }, callback);
}
function tagPrTimeout(opts, callback) {
  tagPr(opts, timeoutTpl, {

  }, callback);
}

/*
opts
  user
  repo
  number
 */
function lookAt(opts, callback) {
  var project = getRepoProject(opts);
  if (!project) {
    return callback(new Error('no_project'));
  }

  github.pullRequests.get({
    user: opts.user,
    repo: opts.repo,
    number: opts.number
  }, function(err, pr) {
    if (err) return callback(err);

    var prCreatedDate = new Date(pr.created_at);

    getChangeNumFromPr({
      user: opts.user,
      repo: opts.repo,
      number: opts.number
    }, function (err, info) {
      if (err) return callback(err);
      var oldStatusId = 0;
      if (info) {
        oldStatusId = info.status;
      }

      getPrAuthorClaStatuses({
        user: opts.user,
        repo: opts.repo,
        number: opts.number
      }, function (err, authors) {
        if (err) return callback(err);

        var closeStatus = -1;
        if (authors.length != 1 || authors[0].commits.length != 1) {
          // Can only have a single commit
          closeStatus = GH_STATUS.TOO_MANY_COMMITS;
        }
        if (authors[0].status !== 'signed') {
          // Must register on gerrit
          closeStatus = GH_STATUS.NO_GERRIT_CLA;
        }

        if (closeStatus !== -1) {
          var curDate = new Date();
          if (curDate.getTime() - prCreatedDate.getTime() >= 7*24*60*60*1000) {
            closeStatus = GH_STATUS.TIMEOUT;
          }

          return maybeTagPullRequest({
            project: project,
            user: opts.user,
            repo: opts.repo,
            number: opts.number,
            oldStatus: oldStatusId,
            newStatus: closeStatus
          }, function(err, tagResult) {
            if (err) return callback(err);

            if (closeStatus !== GH_STATUS.TIMEOUT) {
              return callback(null, tagResult);
            }

            github.issues.edit({
              user: opts.user,
              repo: opts.repo,
              number: opts.number,
              state: 'closed'
            }, function (err) {
              if (err) return callback(err);

              callback(null, tagResult);
            });
          });
        }

        buildChangesetFromPr({
          user: opts.user,
          repo: opts.repo,
          number: opts.number
        }, function (err, state, changeId) {
          if (err && err.message.match(/all_changes_closed/)) {
            return maybeTagPullRequest({
              project: project,
              user: opts.user,
              repo: opts.repo,
              number: opts.number,
              changeId: changeId,
              commitSha: authors[0].commits[0],
              oldStatus: oldStatusId,
              newStatus: GH_STATUS.GERRIT_CLOSED
            }, function (err, tagResult) {
              if (err) return callback(err);

              github.issues.edit({
                user: opts.user,
                repo: opts.repo,
                number: opts.number,
                state: 'closed'
              }, function (err) {
                if (err) return callback(err);

                callback(null, tagResult);
              });

            });
          }
          if (err) return callback(err);

          var newStatus = GH_STATUS.GERRIT_PUSHED;
          if (state === 'new') {
            newStatus = GH_STATUS.GERRIT_CREATED;
          }

          if (state === 'no_changes' && oldStatusId >= GH_STATUS.GERRIT_CREATED) {
            newStatus = GH_STATUS.NO_CHANGES;
          }

          return maybeTagPullRequest({
            project: project,
            user: opts.user,
            repo: opts.repo,
            number: opts.number,
            changeId: changeId,
            commitSha: authors[0].commits[0],
            oldStatus: oldStatusId,
            newStatus: newStatus
          }, callback);
        })
      })
    });
  });
}

module.exports.lookAt = function(opts, callback) {
  console.log('invoking lookAt', opts);
  lookAt(opts, function(err, res) {
    if (err) {
      return console.error(err.stack);
    }
    console.log('done', res);

    callback(err, getGhStatusTag(res));
  })
};

module.exports.claVerify = function(opts, callback) {
  console.log('invoking claVerify', opts);
  getPrAuthorClaStatuses({
    user: opts.user,
    repo: opts.repo,
    number: opts.number
  }, function (err, res) {
    if (err) {
      return console.error(err.stack);
    }
    console.log('done', res);

    callback(err, res);
  });
};
