export class GostergeError extends Error {
	constructor(
		msg: string,
		public kind: "git" | "cline" | "api" | "timeout" | "internal" = "internal",
	) {
		super(msg)
		this.name = "GostergeError"
	}
}
