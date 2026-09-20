export function runDestinationBaseline() {
  return { app: 'destination', status: 'dashboard-ready', hasUploadFeature: false } as const;
}
