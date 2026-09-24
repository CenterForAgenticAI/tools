import type { Context, Tool } from "@earendil-works/pi-ai";

type TranscriptTextBlock = {
  readonly type: "text";
  readonly text: string;
};

type TranscriptSystemMessage = {
  readonly role: "system";
  readonly content: string | readonly TranscriptTextBlock[];
  readonly sections?: Readonly<Record<string, string | null>>;
  readonly toolsAdded?: readonly Tool[];
  readonly toolsRemoved?: readonly { readonly name: string }[];
};

function isTranscriptSystemMessage(
  message: unknown,
): message is TranscriptSystemMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "system"
  );
}

function transcriptContentText(
  content: TranscriptSystemMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is TranscriptTextBlock =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Replays Pi 0.87 provider-facing transcript declarations into the Pi 0.84
 * Context shape consumed by the exact-pinned OAuth stream and local adaptive
 * derivative. Legacy contexts contain no system messages and pass through by
 * identity.
 */
export function toPinnedAnthropicContext(context: Context): Context {
  const transcriptMessages = context.messages as readonly unknown[];
  if (!transcriptMessages.some(isTranscriptSystemMessage)) return context;

  const promptContent: string[] = [];
  const promptSections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  const messages: Context["messages"] = [];

  for (const message of transcriptMessages) {
    if (!isTranscriptSystemMessage(message)) {
      messages.push(message as Context["messages"][number]);
      continue;
    }

    const content = transcriptContentText(message.content);
    if (content.length > 0) promptContent.push(content);

    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) promptSections.delete(name);
      else promptSections.set(name, value);
    }

    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }

  const systemPrompt = [...promptContent, ...promptSections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const pinnedContext: Context = { messages };
  if (systemPrompt.length > 0) pinnedContext.systemPrompt = systemPrompt;
  if (tools.size > 0) pinnedContext.tools = [...tools.values()];
  return pinnedContext;
}
