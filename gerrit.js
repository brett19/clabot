var request = require('request');
var url = require('url');
var config = require('./config');

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
      return callback(err);
    }

    if (response.statusCode != 200) {
      if (response.statusCode == 404) {
        return callback(new Error('not_found'));
      }
      return callback(new Error('HTTP Error ' + response.statusCode));
    }

    var parsedBody = null;
    try {
      parsedBody = JSON.parse(body.substr(4));
    } catch (e) {
    }
    callback(null, parsedBody);
  });
}

function GerritApi() {
}

GerritApi.prototype.getAccountGroups = function(accountId, callback) {
  return gerrit_request({
    method: 'GET',
    path: '/accounts/' + accountId + '/groups'
  }, callback);
};

GerritApi.prototype.queryChanges = function(query, callback) {
  return gerrit_request({
    method: 'GET',
    path: '/changes/?q=' + query
  }, callback);
};

GerritApi.prototype.getChange = function(changeId, callback) {
  return gerrit_request({
    method: 'GET',
    path: '/changes/' + changeId
  }, callback);
};

GerritApi.prototype.getChangeDetails = function(changeId, callback) {
  return gerrit_request({
    method: 'GET',
    path: '/changes/' + changeId + '/detail'
  }, callback);
};

GerritApi.prototype.getChangeRevision = function(changeId, revisionId, callback) {
  return gerrit_request({
    method: 'GET',
    path: '/changes/' + changeId + '/revisions/' + revisionId + '/review'
  }, callback);
};

GerritApi.prototype.postChangeReview = function(changeId, revisionId, data, callback) {
  return gerrit_request({
    method: 'POST',
    path: '/changes/' + changeId + '/revisions/' + revisionId + '/review',
    json: true,
    body: data
  }, callback)
};

var gerrit = new GerritApi();
module.exports = gerrit;
