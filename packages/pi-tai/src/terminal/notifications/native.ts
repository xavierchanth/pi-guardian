export type NotificationSender = (title: string, body: string) => void;

export function sendNativeTerminalNotification(title: string, body: string): void {
  process.stdout.write(terminalNotificationSequence(process.env, title, body));
}

export function terminalNotificationSequence(
  env: NodeJS.ProcessEnv,
  title: string,
  body: string,
): string {
  const safeTitle = sanitize(title);
  const safeBody = sanitize(body);
  if (env.KITTY_WINDOW_ID) {
    return (
      `\x1b]99;i=pi-tai:d=0;${safeTitle}\x1b\\` + `\x1b]99;i=pi-tai:p=body;${safeBody}\x1b\\\x07`
    );
  }
  return `\x1b]777;notify;${safeTitle};${safeBody}\x07\x07`;
}

function sanitize(value: string): string {
  return value.replace(/[\x00-\x1f\x7f;]+/g, " ").trim();
}
