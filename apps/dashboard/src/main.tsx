import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { Overview } from "./Overview";
import { Activity, DecisionPage, EntityPage, EventPage } from "./Activity";
import { CheckPage, Checks } from "./Checks";
import { MetricPage, Metrics } from "./Metrics";
import { Settings } from "./Settings";
import "./style.css";

const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: "/", element: <Overview /> },
      { path: "/checks", element: <Checks /> },
      { path: "/checks/:name", element: <CheckPage /> },
      { path: "/inspect/check", element: <CheckPage /> },
      { path: "/inspect/event", element: <EventPage /> },
      { path: "/inspect/entity", element: <EntityPage /> },
      { path: "/activity", element: <Activity /> },
      { path: "/activity/decisions/:id", element: <DecisionPage /> },
      { path: "/activity/events/:id", element: <EventPage /> },
      { path: "/entities/:kind/:id", element: <EntityPage /> },
      { path: "/metrics", element: <Metrics /> },
      { path: "/metrics/:name", element: <MetricPage /> },
      { path: "/settings", element: <Settings /> },
      {
        path: "*",
        element: (
          <>
            <h1>Page not found.</h1>
            <Link to="/checks">Return to Checks</Link>
          </>
        ),
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
