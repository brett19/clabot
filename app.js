var wobot = require('wobot');
var express = require('express');
var bodyParser = require('body-parser')
var prlogic = require('./prlogic');
var config = require('./config');

// ---------------------------------------------
// HipChat Bot Handling
// ---------------------------------------------
var b = new wobot.Bot({
  jid: config.hipchat.user,
  password: config.hipchat.pass
});

b.connect();

function b_handle_verify(channel, prUser, prRepo, prNum) {
  prlogic.claVerify({
    user: prUser,
    repo: prRepo,
    number: prNum
  }, function(err, authors) {
    if (err) {
      b.message(channel, 'Failed to verify... Something is wrong :(');
      return;
    }

    var msg = '';
    for (var i = 0; i < authors.length; ++i) {
      if (msg != '') msg = msg + '\n';

      msg += '   ' + authors[i].name + ' (' + authors[i].commits.length + ' commits): ';
      if (authors[i].status == 'not_registered') {
        msg += 'Not Registered';
      } else if (authors[i].status == 'registered') {
        msg += 'Not Signed CLA';
      } else if (authors[i].status == 'signed') {
        msg += 'CLA Signed - Woo!';
      } else {
        msg += 'Unknown';
      }
    }

    var msgout = '';
    msgout += 'For PR # ' + prNum + ' on ' + prUser + '/' + prRepo + '\n';
    msgout += msg;
    b.message(channel, msgout);
  });
}
function b_handle_lookat(channel, prUser, prRepo, prNum) {
  prlogic.lookAt({
    user: prUser,
    repo: prRepo,
    number: prNum
  }, function(err, res) {
    if (err) {
      b.message(channel, 'Failed to lookat... Something is wrong :(');
      return;
    }

    var msgout = '';
    msgout += 'For PR # ' + prNum + ' on ' + prUser + '/' + prRepo + '\n';
    msgout += '  result was: ' + res;
    b.message(channel, msgout);
  });
}
function b_handle_message(channel, message) {
  var verify_match = message.match(/verify ([^ ]*)github.com\/([^\/]*)\/([^\/]*)\/pull\/([0-9]*)/);
  if (verify_match) {
    var prUser = verify_match[2];
    var prRepo = verify_match[3];
    var prNum = parseInt(verify_match[4]);
    b_handle_verify(channel, prUser, prRepo, prNum);
  }

  var lookat_match = message.match(/lookat ([^ ]*)github.com\/([^\/]*)\/([^\/]*)\/pull\/([0-9]*)/);
  if (lookat_match) {
    var prUser = lookat_match[2];
    var prRepo = lookat_match[3];
    var prNum = parseInt(lookat_match[4]);
    b_handle_lookat(channel, prUser, prRepo, prNum);
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

    prlogic.lookAt({
      user: owner_name,
      repo: repo_name,
      number: pr_num
    }, function() {})
  }
  res.send(200);
});

var server = app.listen(config.github.webhook_port, function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log('Webhook processor listening at http://%s:%s', host, port);
});
