module.exports = {
  apps: [{
    name: "email-agent",
    script: "npm",
    args: "start",
    interpreter: "none",
    cwd: "/Users/edwardc/Projects/email-agent",
    env: {
      NODE_ENV: "production",
      TZ: "America/Los_Angeles"
    },
    max_restarts: 10,
    min_uptime: 5000,
    restart_delay: 2000,
    exp_backoff_restart_delay: 1000,
    kill_timeout: 5000,
    merge_logs: true,
    log_date_format: "MM/DD HH:mm"
  }]
};

