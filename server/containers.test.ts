import { expect, it, vi } from "vite-plus/test";
import type {
  ContainerInfo,
  RemoteContainersResponse,
  RemoteSystemContainers,
} from "../shared/types.ts";
import { aggregateContainers } from "./containers.ts";

const localContainer: ContainerInfo = {
  id: "0123456789ab",
  name: "homie",
  image: "homie:latest",
  state: "running",
  status: "Up 1 hour",
  ports: ["3000:3000"],
};

function remoteGroup(
  systemId: string,
  containers: RemoteSystemContainers["containers"],
  error?: string,
): RemoteSystemContainers {
  return {
    systemId,
    systemName: systemId,
    systemHost: `${systemId}.test`,
    systemStatus: "up",
    containers,
    ...(error ? { error } : {}),
  };
}

function remoteResponse(bySystem: RemoteSystemContainers[] = []): RemoteContainersResponse {
  return { configured: true, bySystem };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("keeps remote containers when local Docker fails", async () => {
  const error = new Error("secret docker failure");
  const onError = vi.fn();
  const result = await aggregateContainers({
    local: { name: "homie", load: () => Promise.reject(error) },
    remote: {
      load: async () => remoteResponse([remoteGroup("nas", [{ name: "jellyfin", cpuPct: 12 }])]),
    },
    onError,
  });

  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    configured: true,
    sources: [
      { id: "local", name: "homie", error: "docker unreachable" },
      { id: "nas", name: "nas" },
    ],
    containers: [
      {
        name: "jellyfin",
        state: "running",
        source: "remote",
        systemId: "nas",
        systemName: "nas",
        cpuPct: 12,
        memPct: undefined,
        netBytes: undefined,
      },
    ],
    partial: true,
  });
  expect(onError).toHaveBeenCalledWith("local", error);
  expect(JSON.stringify(result.body)).not.toContain("secret docker failure");
});

it("keeps local containers when the remote source fails", async () => {
  const error = new Error("secret beszel failure");
  const onError = vi.fn();
  const result = await aggregateContainers({
    local: { name: "homie", load: async () => [localContainer] },
    remote: { load: () => Promise.reject(error) },
    onError,
  });

  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    configured: true,
    sources: [
      { id: "local", name: "homie" },
      { id: "beszel", name: "Beszel", error: "beszel unreachable" },
    ],
    containers: [{ ...localContainer, source: "local", systemName: "local" }],
    partial: true,
  });
  expect(onError).toHaveBeenCalledWith("remote", error);
  expect(JSON.stringify(result.body)).not.toContain("secret beszel failure");
});

it("keeps healthy remote machines when one machine fails", async () => {
  const result = await aggregateContainers({
    remote: {
      load: async () =>
        remoteResponse([
          remoteGroup("nas", [{ name: "jellyfin" }]),
          remoteGroup("broken", [], "container stats unavailable"),
          remoteGroup("empty", []),
        ]),
    },
  });

  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    configured: true,
    sources: [
      { id: "nas", name: "nas" },
      { id: "broken", name: "broken", error: "container stats unavailable" },
      { id: "empty", name: "empty" },
    ],
    containers: [
      {
        name: "jellyfin",
        state: "running",
        source: "remote",
        systemId: "nas",
        systemName: "nas",
        cpuPct: undefined,
        memPct: undefined,
        netBytes: undefined,
      },
    ],
    partial: true,
  });
  expect(result.body.sources.find((source) => source.id === "empty")).not.toHaveProperty("error");
});

it("returns 502 with sanitized metadata when every source fails", async () => {
  const result = await aggregateContainers({
    local: { name: "homie", load: () => Promise.reject(new Error("secret docker failure")) },
    remote: { load: () => Promise.reject(new Error("secret beszel failure")) },
  });

  expect(result).toEqual({
    status: 502,
    body: {
      configured: true,
      sources: [
        { id: "local", name: "homie", error: "docker unreachable" },
        { id: "beszel", name: "Beszel", error: "beszel unreachable" },
      ],
      containers: [],
      error: "containers unreachable",
    },
  });
  expect(JSON.stringify(result.body)).not.toMatch(/secret (docker|beszel) failure/);
});

it("returns 502 when every monitored remote machine fails", async () => {
  const result = await aggregateContainers({
    remote: {
      load: async () => remoteResponse([remoteGroup("broken", [], "container stats unavailable")]),
    },
  });

  expect(result.status).toBe(502);
  expect(result.body).toMatchObject({
    configured: true,
    containers: [],
    error: "containers unreachable",
    sources: [{ id: "broken", name: "broken", error: "container stats unavailable" }],
  });
});

it("reports no configuration without inventing a local source", async () => {
  expect(await aggregateContainers({})).toEqual({
    status: 200,
    body: { configured: false, sources: [], containers: [] },
  });
});

it("starts local and remote loads concurrently", async () => {
  const local = deferred<ContainerInfo[]>();
  const remote = deferred<RemoteContainersResponse>();
  const loadLocal = vi.fn(() => local.promise);
  const loadRemote = vi.fn(() => remote.promise);

  const pending = aggregateContainers({
    local: { name: "homie", load: loadLocal },
    remote: { load: loadRemote },
  });

  // Both loaders start before either source resolves, so one slow source cannot block the other.
  expect(loadLocal).toHaveBeenCalledTimes(1);
  expect(loadRemote).toHaveBeenCalledTimes(1);

  local.resolve([localContainer]);
  remote.resolve(remoteResponse([remoteGroup("nas", [{ name: "jellyfin" }])]));

  await expect(pending).resolves.toMatchObject({
    status: 200,
    body: {
      containers: [{ name: "homie" }, { name: "jellyfin" }],
    },
  });
});
