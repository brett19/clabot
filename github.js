var GitHubApi = require('github');
var config = require('./config');

var github = new GitHubApi({
  version: '3.0.0',
  headers: {
    'user-agent': 'Couchbase SDK Bot'
  }
});

github.authenticate({
  type: "token",
  token: config.github.api_key
});

module.exports = github;
