import { execSync } from "child_process"
import { GostergeError } from "./errors"

export function checkGitBinary(): void {
	try {
		execSync("git --version", { stdio: "ignore" })
	} catch (error) {
		throw new GostergeError("Git binary not found. Please ensure Git is installed and in your system's PATH.", "git")
	}
}
