/** Construct clone arguments only for the published kernel's GitHub HTTPS source. */
export function repositoryCloneArgs(repositoryUrl, repoDir) {
	if (typeof repositoryUrl !== "string" || !/^https:\/\/github\.com\//u.test(repositoryUrl)) {
		throw new Error("acp-kernel repository must use https://github.com/");
	}
	return ["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", repositoryUrl, repoDir];
}
