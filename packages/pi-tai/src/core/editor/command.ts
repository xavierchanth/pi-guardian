export interface EditorInvocation {
  executable: string;
  args: string[];
}

export const NEOVIM_RESPONSE_POSITION_COMMAND = "+call cursor(search('^<response>$', 'nw') + 1, 1)";

export function parseEditorCommand(command: string): EditorInvocation | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const next = command[index + 1];
        if (next === '"' || next === "\\") {
          token += next;
          index += 1;
        } else {
          token += character;
        }
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    tokenStarted = true;
    if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (character === "\\") {
      const next = command[index + 1];
      if (next && (/\s/.test(next) || next === "'" || next === '"' || next === "\\")) {
        token += next;
        index += 1;
      } else {
        token += character;
      }
    } else {
      token += character;
    }
  }

  if (quote) return undefined;
  if (tokenStarted) tokens.push(token);
  const [executable, ...args] = tokens;
  return executable ? { executable, args } : undefined;
}

export function isNeovimInvocation(invocation: EditorInvocation): boolean {
  if (isNeovimExecutable(invocation.executable)) return true;
  if (!isEnvExecutable(invocation.executable)) return false;

  const wrappedExecutable = invocation.args.find(
    (argument) => !argument.startsWith("-") && !isEnvironmentAssignment(argument),
  );
  return wrappedExecutable ? isNeovimExecutable(wrappedExecutable) : false;
}

export function buildEditorArguments(
  invocation: EditorInvocation,
  tempFile: string,
  positionInResponse: boolean,
): string[] {
  return [
    ...invocation.args,
    ...(positionInResponse && isNeovimInvocation(invocation)
      ? [NEOVIM_RESPONSE_POSITION_COMMAND]
      : []),
    tempFile,
  ];
}

function isNeovimExecutable(executable: string): boolean {
  const name = executableName(executable);
  return name === "nvim" || name === "nvim.exe";
}

function isEnvExecutable(executable: string): boolean {
  const name = executableName(executable);
  return name === "env" || name === "env.exe";
}

function executableName(executable: string): string {
  return executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function isEnvironmentAssignment(argument: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(argument);
}
