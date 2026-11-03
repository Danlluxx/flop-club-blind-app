import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        graphite: "#080405",
        panel: "rgba(14, 8, 10, 0.86)",
        electric: "#ff334f",
        violet: "#6b58ff",
        emerald: "#ff7985",
      },
      boxShadow: {
        glow: "0 24px 80px rgba(255, 51, 79, 0.22)",
        card: "0 18px 44px rgba(0, 0, 0, 0.28)",
      },
    },
  },
} satisfies Config;
