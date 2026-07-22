import { readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import {
  CURRENT_PROTOCOL_VERSION,
  parseServerFrame,
  type ClientFrame,
  type HostCommand,
  type ImplementationInfo,
  type ServerFrame,
} from "@pi-tai/host-protocol";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export async function readAuthToken(path: string): Promise<string> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("Pi-Tai Host token file permissions must be 0600.");
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Pi-Tai Host token is invalid.");
  return token.toLowerCase();
}

export class HostConnection {
  private readonly socket: Socket;
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<{
    resolve: (frame: ServerFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  private buffer = Buffer.alloc(0);
  private closed?: Error;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Pi-Tai Host connection closed.")));
  }

  static async connect(input: {
    socketPath: string;
    token: string;
    client: ImplementationInfo;
  }): Promise<HostConnection> {
    const socket = createConnection(input.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const connection = new HostConnection(socket);
    await connection.write({
      type: "authenticate",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      token: input.token,
      client: input.client,
    });
    const authenticated = await connection.read();
    if (authenticated.type !== "authenticated") {
      connection.close();
      throw new Error(
        authenticated.type === "error"
          ? authenticated.error.message
          : "Pi-Tai Host authentication failed.",
      );
    }
    return connection;
  }

  async command(command: HostCommand): Promise<unknown> {
    await this.write({ type: "command", command });
    const frame = await this.read();
    if (frame.type === "error") throw new Error(frame.error.message);
    if (frame.type !== "response") throw new Error("Pi-Tai Host returned an unexpected frame.");
    if (frame.response.outcome.status === "error") {
      throw new Error(frame.response.outcome.error.message);
    }
    return frame.response.outcome.result;
  }

  async write(frame: ClientFrame): Promise<void> {
    const body = Buffer.from(JSON.stringify(frame));
    if (body.byteLength > MAX_FRAME_BYTES) throw new Error("Pi-Tai Host frame is too large.");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.byteLength);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, body]), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  read(): Promise<ServerFrame> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    this.socket.destroy();
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error("Pi-Tai Host frame is too large."));
        return;
      }
      if (this.buffer.byteLength < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let frame: ServerFrame;
      try {
        frame = parseServerFrame(JSON.parse(body.toString("utf8")));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid Pi-Tai Host frame."));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}
