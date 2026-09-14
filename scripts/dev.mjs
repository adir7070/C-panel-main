// `npm run dev`: the backend process (API, sockets, panel routes) on PORT
// from .env, plus Vite with HMR, which proxies server paths to it.
import { spawn } from "child_process";

const procs = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "backend/server.js"], { stdio: "inherit" }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
const stop = () => procs.forEach(p => p.exitCode === null && p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach(p => p.on("exit", code => { stop(); if (code) process.exitCode = code; }));
