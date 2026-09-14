const startDailyDigestJob = require('./daily-digest.job')

module.exports = function startAllJobs(io) {
  startDailyDigestJob()
}
