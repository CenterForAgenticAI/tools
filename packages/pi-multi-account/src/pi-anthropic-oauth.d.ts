declare module "pi-anthropic-oauth/src/index.ts" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

  const piAnthropicOAuth: (pi: ExtensionAPI) => void;
  export default piAnthropicOAuth;
}
