import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ViewerWindow from "./ViewerWindow";
import "./styles.css";

const isViewerWindow = new URLSearchParams(window.location.search).has("viewer");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isViewerWindow ? <ViewerWindow /> : <App />}</React.StrictMode>,
);
