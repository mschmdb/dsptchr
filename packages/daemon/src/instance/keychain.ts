import { execFile } from "node:child_process";

export interface KeychainRef {
  service: string;
  account: string;
}

export interface Keychain {
  read(ref: KeychainRef): Promise<string | undefined>;
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

const SECURITY_BIN = "/usr/bin/security";
const ITEM_NOT_FOUND = 44;

export function macosKeychain(run: RunCommand = runCommand): Keychain {
  return {
    async read(ref) {
      const result = await run(SECURITY_BIN, ["find-generic-password", "-s", ref.service, "-a", ref.account, "-w"]);
      if (result.exitCode === ITEM_NOT_FOUND) {
        return undefined;
      }
      if (result.exitCode !== 0) {
        throw new Error(`keychain lookup failed with exit code ${result.exitCode}`);
      }
      return result.stdout.replace(/\n$/, "");
    },
  };
}

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode: code, stdout });
    });
  });
