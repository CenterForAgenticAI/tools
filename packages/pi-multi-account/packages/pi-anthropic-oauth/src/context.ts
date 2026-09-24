import type { Context, Message, Tool } from "@earendil-works/pi-ai";

interface ProjectedContext {
  messages: Message[];
  systemPrompt: string;
  tools: Tool[];
}

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isSystemMessage(value: unknown): value is UnknownRecord & {
  role: "system";
} {
  return isRecord(value) && value.role === "system";
}

function isConversationMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value.role === "user" ||
      value.role === "assistant" ||
      value.role === "toolResult")
  );
}

function isTool(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.parameters)
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/**
 * Project both legacy Context fields and current transcript system messages into
 * the single prompt/tool snapshot required by the OAuth Anthropic endpoint.
 *
 * This mirrors Pi's transcript replay helpers without importing their newer-only
 * module path, preserving this package's Pi 0.80.8 peer compatibility.
 */
export function projectContext(context: Context): ProjectedContext {
  const promptParts = context.systemPrompt ? [context.systemPrompt] : [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  const messages: Message[] = [];

  for (const tool of context.tools ?? []) tools.set(tool.name, tool);

  const sourceMessages: readonly unknown[] = context.messages;
  for (const message of sourceMessages) {
    if (!isSystemMessage(message)) {
      if (isConversationMessage(message)) messages.push(message);
      continue;
    }

    if (message.replace === true) {
      promptParts.length = 0;
      sections.clear();
      tools.clear();
    }

    const text = contentText(message.content);
    if (text.length > 0) promptParts.push(text);

    if (isRecord(message.sections)) {
      for (const [name, value] of Object.entries(message.sections)) {
        if (value === null) sections.delete(name);
        else if (typeof value === "string") sections.set(name, value);
      }
    }

    if (Array.isArray(message.toolsRemoved)) {
      for (const reference of message.toolsRemoved) {
        if (isRecord(reference) && typeof reference.name === "string") {
          tools.delete(reference.name);
        }
      }
    }

    if (Array.isArray(message.toolsAdded)) {
      for (const tool of message.toolsAdded) {
        if (isTool(tool)) tools.set(tool.name, tool);
      }
    }
  }

  return {
    messages,
    systemPrompt: [...promptParts, ...sections.values()]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    tools: [...tools.values()],
  };
}
