module.exports = {
  apps: [{
    name: "slot-sentinel",
    script: "server.js",
    env: {
      PORT: 9800,
      SS_TOKEN: "改成你自己的token"
    },
    autorestart: true,
    max_restarts: 50,
    restart_delay: 3000,
    max_memory_restart: "200M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    merge_logs: true
  }]
};
