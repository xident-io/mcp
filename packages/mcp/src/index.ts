#!/usr/bin/env node
import { configFromEnv } from "./config.js";
import { startHTTPServer } from "./http.js";

const cfg = configFromEnv(process.env);
startHTTPServer(cfg);
