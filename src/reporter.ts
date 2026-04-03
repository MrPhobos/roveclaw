import http from "http";
import { logger } from "./logger.js";

interface ReporterConfig {
  url: string;
  auth: string;
  agentId: string;
  agentName: string;
  device: string;
  parentAgentId?: string;
}

interface EventPayload {
  event_type: string;
  summary: string;
  details?: Record<string, unknown>;
  entities?: Array<{ type: string; id: string }>;
  tokens?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_create?: number;
    model: string;
  };
}

export class WatchtowerReporter {
  private readonly config: ReporterConfig;

  constructor(config: ReporterConfig) {
    this.config = config;
  }

  async send(payload: EventPayload): Promise<void> {
    const event = {
      agent_id: this.config.agentId,
      agent_name: this.config.agentName,
      device: this.config.device,
      parent_agent_id: this.config.parentAgentId,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    await this.post("/api/events", event);
  }

  async heartbeat(status: string): Promise<void> {
    await this.post("/api/heartbeat", {
      agent_id: this.config.agentId,
      status,
    });
  }

  startHeartbeatLoop(intervalMs = 30000): NodeJS.Timeout {
    return setInterval(() => {
      this.heartbeat("active").catch(() => {});
    }, intervalMs);
  }

  private post(path: string, body: unknown): Promise<void> {
    return new Promise((resolve) => {
      const urlObj = new URL(this.config.url);
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path,
          method: "POST",
          timeout: 5000,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            Authorization:
              "Basic " + Buffer.from(this.config.auth).toString("base64"),
          },
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
      req.on("error", (err) => {
        logger.debug({ err: err.message }, "Watchtower reporter: send failed");
        resolve();
      });
      req.write(data);
      req.end();
    });
  }
}
