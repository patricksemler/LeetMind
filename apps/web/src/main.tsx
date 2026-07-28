import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { StaticDemoApp } from "./demo/DemoExperience";
import { queryClient } from "./lib/queryClient";
import "highlight.js/styles/github-dark.min.css";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

const content = import.meta.env.MODE === "demo" ? <StaticDemoApp /> : <App />;

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{content}</BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
