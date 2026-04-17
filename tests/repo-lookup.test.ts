import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { answerRepoLookup } from "../dist/repo-lookup.js";

test("answers HTTP app entrypoint lookup from local repos without model", () => {
  const root = join(tmpdir(), `kai-repos-${Date.now()}`);
  const serviceDir = join(root, "kodif-gateway", "src", "main", "java", "com", "example");
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(join(serviceDir, "KodifGatewayApplication.java"), [
    "package com.example;",
    "",
    "@SpringBootApplication",
    "public class KodifGatewayApplication {",
    "  public static void main(String[] args) {",
    "    SpringApplication.run(KodifGatewayApplication.class, args);",
    "  }",
    "}",
  ].join("\n"));

  try {
    const result = answerRepoLookup("which file starts HTTP app in repos/kodif-gateway?", root);
    assert(result);
    assert.match(result.answer, /Spring Boot/);
    assert.match(result.answer, /repos\/kodif-gateway\/src\/main\/java\/com\/example\/KodifGatewayApplication\.java/);
    assert.match(result.answer, /line 6/);
    assert.match(result.answer, /SpringApplication\.run/);
    assert.equal(result.hit.framework, "Spring Boot");
    assert.equal(result.scannedFiles, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores non-lookup questions", () => {
  assert.equal(answerRepoLookup("review repos/kodif-gateway for security", "repos"), null);
});
