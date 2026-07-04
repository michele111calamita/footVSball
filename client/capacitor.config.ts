import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.footvsball.app",
  appName: "footVSball",
  webDir: "dist",
  backgroundColor: "#0e5c2f",
  android: {
    allowMixedContent: false,
  },
};

export default config;
