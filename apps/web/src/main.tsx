import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

const root = createRoot(rootEl);

async function render() {
  if (import.meta.env.MODE === "demo") {
    const { StaticDemoApp } = await import("./demo/DemoExperience");
    root.render(
      <StrictMode>
        <StaticDemoApp />
      </StrictMode>,
    );
    return;
  }

  const [{ QueryClientProvider }, { BrowserRouter }, { App }, { queryClient }] = await Promise.all([
    import("@tanstack/react-query"),
    import("react-router-dom"),
    import("./App"),
    import("./lib/queryClient"),
  ]);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void render();
