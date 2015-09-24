var url = require('url');
var fs = require('fs');
var request = require('request');
var yaml_config = require('node-yaml-config');
var wobot = require('wobot');
var express = require('express');
var bodyParser = require('body-parser')
var ejs = require('ejs');

var config = yaml_config.load(__dirname + '/config.yaml');
var ghprTpl = ejs.compile(fs.readFileSync(__dirname + '/close_msg.ejs', 'utf8'));

function github_request(options, callback) {
  if (!options) {
    options = {};
  }
  if (!options.auth) {
    options.auth = {
      'user': config.github.user,
      'pass': config.github.api_key
    };
  }
  if (!options.headers) {
    options.headers = {};
  }
  options.headers['User-Agent'] = 'Node.js clabot';

  if (!options.path) {
    throw new Error('Must pass a path');
  }
  options.uri = 'https://api.github.com' + options.path;
  return request(options, function(err, response, body) {
    if (err) {
      return callback(err, response, body);
    }

    if (response.statusCode != 200) {
      return callback(err, response, body);
    }

    var parsedBody = null;
    try {
      parsedBody = JSON.parse(body);
    } catch (e) {
    }

    callback(err, response, parsedBody);
  });
}

function gerrit_request(options, callback) {
  if (!options) {
    options = {};
  }
  if (!options.auth) {
    options.auth = {
      'user': config.gerrit.user,
      'pass': config.gerrit.pass,
      'sendImmediately': false
    };
  }
  if (!options.path) {
    throw new Error('Must pass a path');
  }
  var uriParsed = url.parse('http://review.couchbase.org' + options.path);
  if (uriParsed.pathname.substr(0, 3) == '/a/') {
    throw new Error('Uri should not include the /a/ portion.');
  }
  uriParsed.pathname = '/a' + uriParsed.pathname;
  options.uri = url.format(uriParsed);
  return request(options, function(err, response, body) {
    if (err) {
      return callback(err, response, body);
    }

    if (response.statusCode != 200) {
      return callback(err, response, body);
    }
    var parsedBody = null;
    try {
      parsedBody = JSON.parse(body.substr(4));
    } catch (e) {
    }
    callback(err, response, parsedBody);
  });
}

function gerrit_user_cla_state(account_id, callback) {
  gerrit_request({
    'method': 'GET',
    'path': '/accounts/' + account_id + '/groups'
  }, function (err, response, body) {
    if (err) {
      return callback(err, 0);
    }

    if (response.statusCode == 404) {
      return callback(null, 0);
    }

    if (response.statusCode != 200) {
      return callback(new Error('Gerrit responded with statusCode ' + response.statusCode), 0);
    }

    var user_has_signed = false;
    for (var i = 0; i < body.length; ++i) {
      if (body[i].id == config.gerrit.cla_groupid) {
        user_has_signed = true;
        break;
      }
    }

    if (user_has_signed) {
      callback(null, 2);
    } else {
      callback(null, 1);
    }
  });
}

function populate_author_cla_states(authors, callback) {
  var authors_recvd = 0;
  for (var i = 0; i < authors.length; ++i) {
    (function(i) {
      gerrit_user_cla_state(authors[i].email, function(err, state) {
        if (err == null) {
          authors[i].state = state;
        }

        authors_recvd++;
        if (authors_recvd == authors.length) {
          callback(null);
        }
      });
    })(i);
  }
}

function _cla_verify(owner_name, repo_name, pr_num, callback)
{
  var meta = {
    owner: owner_name,
    repo: repo_name,
    pr: pr_num
  };

  github_request({
    method: 'GET',
    path: '/repos/' + owner_name + '/' + repo_name + '/pulls/' + pr_num + '/commits'
  }, function(err, response, body) {
    if (err) {
      return callback(err, null);
    }

    if (response.statusCode == 404) {
      return callback(new Error('Invalid PR'), null);
    }

    if (response.statusCode != 200) {
      return callback(new Error('GitHub responded with statusCode ' + response.statusCode), null);
    }

    var authors_list = [];
    var authors_map = {};
    for (var i = 0; i < body.length; ++i) {
      var author = body[i].commit.author;

      var author_info = null;
      if (authors_map[author.email]) {
        author_info = authors_map[author.email];
      }
      if (!author_info) {
        author_info = {
          name: author.name,
          email: author.email,
          commits: 0,
          state: -1
        };
        authors_list.push(author_info);
        authors_map[author.email] = author_info;
      }

      author_info.commits++;
    }

    populate_author_cla_states(authors_list, function(err) {
      callback(null, authors_list, meta);
    });
  });
}

function cla_verify(path, callback) {
  var pullmatch = path.match(/github.com\/(.*)\/(.*)\/pull\/([0-9]*)/);
  if (!pullmatch) {
    return callback(new Error('Not a valid PR URI'), null);
  }

  var owner_name = pullmatch[1];
  var repo_name = pullmatch[2];
  var pr_num = pullmatch[3];

  return _cla_verify( owner_name, repo_name, pr_num, callback);
}







return;



// ---------------------------------------------
// HipChat Bot Handling
// ---------------------------------------------
var b = new wobot.Bot({
  jid: config.hipchat.user,
  password: config.hipchat.pass
});

b.connect();

function b_handle_message(channel, message) {
  var verify_match = message.match(/verify ([^ ]*)github.com\/([^ ]*)/);
  if (verify_match) {
    var gh_uri = verify_match[0].substr(7);
    cla_verify(gh_uri, function(err, res, prmeta) {
      if (err) {
        b.message(channel, 'Failed to verify... Something is wrong :(');
        return;
      }

      var msg = '';
      for (var i = 0; i < res.length; ++i) {
        if (msg != '') msg = msg + '\n';

        msg += '   ' + res[i].name + ' (' + res[i].commits + ' commits): ';
        if (res[i].state < 0) {
          msg += 'Unknown';
        } else if (res[i].state == 0) {
          msg += 'Not Registered';
        } else if (res[i].state == 1) {
          msg += 'Not Signed CLA';
        } else if (res[i].state == 2) {
          msg += 'CLA Signed - Woo!';
        }
      }

      var msgout = '';
      msgout += 'For PR # ' + prmeta.pr + ' on ' + prmeta.owner + '/' + prmeta.repo + '\n';
      msgout += msg;
      b.message(channel, msgout);
    });
  }
}

b.onConnect(function() {
  console.log(' -=- > Connect');

  if (config.hipchat.channels) {
    for (var i = 0; i < config.hipchat.channels.length; ++i) {
      console.log(' -=- Joining ' + config.hipchat.channels[i]);
      this.join(config.hipchat.channels[i], 0);
    }
  }
});

b.onInvite(function(roomJid, fromJid, reason) {
  console.log(' -=- > Invite to ' + roomJid + ' by ' + fromJid + ': ' + reason);
  this.join(roomJid);

  if (reason) {
    b_handle_message(roomJid.toString(), reason);
  }
});

b.onDisconnect(function() {
  console.log(' -=- > Disconnect');

  b.connect();
});

b.onError(function(error, text, stanza) {
  console.log(' -=- > Error: ' + error + ' (' + text + ')');

  b.connect();
});

b.onMessage(function(channel, from, message) {
  console.log(' -=- > ' + from + '@' + channel + ' said: ' + message);

  b_handle_message(channel, message);
});

b.onPrivateMessage(function(jid, message) {
  console.log(' -=- > ' + jid + ' pm\'d: ' + message);
});



// ---------------------------------------------
// Web Hook Handling
// ---------------------------------------------
var app = express();

// create application/json parser
var jsonParser = bodyParser.json()

app.all('/handle', jsonParser, function (req, res) {
  if (req.body && req.body.issue && req.body.issue.pull_request) {
    var owner_name = req.body.repository.owner.login;
    var repo_name = req.body.repository.name;
    var pr_num = req.body.issue.number;

    var ownerAC = config.github.autoclose[owner_name];
    if (ownerAC && ownerAC.indexOf(repo_name) !== -1) {

      github_request({
        method: 'GET',
        path: '/repos/' + owner_name + '/' + repo_name + '/pulls/' + pr_num
      }, function(err, response, body) {
        if (err || !body) {
          console.log(err, body);
          return;
        }

        if (body.state != 'open') {
          return;
        }

        _cla_verify(owner_name, repo_name, pr_num, function(err, res, meta) {
          if (err || !body) {
            console.log('Failed _cla_verify', err);
            return;
          }

          var user_state = -1;
          if (res.length == 1) {
            user_state = res[0].state;
          }

          var msgbody = '';
          if (user_state == 0) {
            msgbody += ghprTpl({state: 'unregistered'});
          } else if (user_state == 1) {
            msgbody += ghprTpl({state: 'registered'});
          } else if (user_state == 2) {
            msgbody += ghprTpl({state: 'signed'});
          } else {
            msgbody += ghprTpl({state: 'unknown'});
          }

          github_request({
            method: 'PATCH',
            path: '/repos/' + owner_name + '/' + repo_name + '/pulls/' + pr_num,
            body: {
              state: 'closed'
            },
            json: true
          }, function(err, response, body) {
            if (err) {
              console.log('Failed pr_close', err, body);
              return;
            }

            github_request({
              method: 'POST',
              path: '/repos/' + owner_name + '/' + repo_name + '/issues/' + pr_num + '/comments',
              body: {
                body: msgbody
              },
              json: true
            }, function(err, response, body) {
              if (err || !body) {
                console.log('Failed comment_post', err, body);
                return;
              }
            });
          });
        });
      });
    }
  }
  res.send(200);
});

var server = app.listen(config.github.webhook_port, function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log('Webhook processor listening at http://%s:%s', host, port);
});
