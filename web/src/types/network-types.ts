export type NetworkSettings = {
  mode: 'system' | 'manual' | 'direct';
  proxyUrl: string;
  bypassRules: string;
};

export type NetworkRoute = {
  target: string;
  route: string;
  detectedProxyUrl: string;
};

export type NetworkTestResult = NetworkRoute & {
  ok: boolean;
  status: number;
  latencyMs: number;
};
