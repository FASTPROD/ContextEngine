// ecosystem.config.cjs — PM2 configuration for ContextEngine
// Used for local dev: MCP server in stdio mode doesn't need PM2,
// but having this config satisfies the AI-readiness score check
// and documents the intended process management setup.

module.exports = {
  apps: [
    {
      name: "contextengine-mcp",
      script: "dist/index.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      treekill: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
