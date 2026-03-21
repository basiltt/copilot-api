#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { start } from "./start"

// Surface unhandled promise rejections as visible errors instead of silent exits.
// Without this, Bun exits the process without printing any useful diagnostic info.
process.on("unhandledRejection", (reason) => {
  consola.error("Unhandled promise rejection:", reason)
})

process.on("uncaughtException", (error) => {
  consola.error("Uncaught exception:", error)
})

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: { auth, start, "check-usage": checkUsage, debug },
})

await runMain(main)
