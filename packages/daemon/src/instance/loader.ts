import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { macosKeychain, type Keychain } from "./keychain.ts";
import { instanceConfigSchema, secretsSchema, type InstanceConfig, type SecretRefs } from "./schema.ts";
import { Secret } from "./secret.ts";

export class InstanceError extends Error {
  override name = "InstanceError";
}

export interface Instance {
  name: string;
  dir: string;
  role: string;
  config: InstanceConfig;
  paths: { stateDb: string; policy: string; sources: string; rules: string };
  secret(name: string): Promise<Secret>;
}

export interface LoadOptions {
  home?: string;
  keychain?: Keychain;
}

const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function defaultHome(): string {
  return process.env["DSPTCHR_HOME"] ?? join(homedir(), ".config", "dsptchr");
}

export async function loadInstance(name: string, options: LoadOptions = {}): Promise<Instance> {
  if (!INSTANCE_NAME.test(name)) {
    throw new InstanceError(`invalid instance name "${name}"`);
  }
  const dir = join(options.home ?? defaultHome(), name);
  if (!(await isDirectory(dir))) {
    throw new InstanceError(`instance directory not found: ${dir}`);
  }

  const configText = await readText(join(dir, "instance.yaml"));
  if (configText === undefined) {
    throw new InstanceError(`instance.yaml missing in ${dir}`);
  }
  const config = parseWith(instanceConfigSchema, configText, "instance.yaml");
  const secretsText = await readText(join(dir, "secrets.yaml"));
  const secretRefs: SecretRefs = secretsText === undefined ? {} : parseWith(secretsSchema, secretsText, "secrets.yaml");
  const role = (await readText(join(dir, "role.md"))) ?? "";
  const keychain = options.keychain ?? macosKeychain();

  return {
    name,
    dir,
    role,
    config,
    paths: {
      stateDb: join(dir, "state.db"),
      policy: join(dir, "policy.yaml"),
      sources: join(dir, "sources.yaml"),
      rules: join(dir, "rules"),
    },
    async secret(secretName) {
      const ref = secretRefs[secretName];
      if (ref === undefined) {
        throw new InstanceError(`unknown secret "${secretName}" in secrets.yaml`);
      }
      const value = await keychain.read(ref.keychain);
      if (value === undefined) {
        throw new InstanceError(`secret "${secretName}" not found in keychain`);
      }
      return new Secret(secretName, value);
    },
  };
}

function parseWith<S extends z.ZodType>(schema: S, text: string, file: string): z.output<S> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new InstanceError(`${file}: invalid YAML (${(error as Error).message})`);
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      const keys = "keys" in issue && Array.isArray(issue.keys) ? ` ${issue.keys.join(", ")}` : "";
      return `${path || "(root)"}: ${issue.message}${keys}`;
    });
    throw new InstanceError(`${file}: ${issues.join("; ")}`);
  }
  return result.data;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new InstanceError(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
