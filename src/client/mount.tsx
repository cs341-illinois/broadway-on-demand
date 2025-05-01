import "bootstrap/dist/css/bootstrap.min.css";
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import HomePage from "./pages/Home";
import { formulateUrl } from "./utils";
import DashboardPage from "./pages/Dashboard";
import { AuthProvider } from "./contexts/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import CourseHomePage from "./pages/CourseHomePage";
import NotFoundPage from "./pages/base/NotFound";
import GradesPage from "./pages/CourseGrades";
import { AlertProvider } from "./contexts/AlertContext";
import AssignmentHomePage from "./pages/AssignmentHomePage";

const router = createBrowserRouter([
  {
    path: formulateUrl("/"),
    element: <HomePage />,
  },
  {
    path: formulateUrl("dashboard"),
    element: (
      <ProtectedRoute>
        <DashboardPage />
      </ProtectedRoute>
    ),
  },
  {
    path: formulateUrl("dashboard/:courseId"),
    element: (
      <ProtectedRoute>
        <CourseHomePage />
      </ProtectedRoute>
    ),
  },
  {
    path: formulateUrl("dashboard/:courseId/:assignmentId"),
    element: (
      <ProtectedRoute>
        <AssignmentHomePage />
      </ProtectedRoute>
    ),
  },
  {
    path: formulateUrl("dashboard/:courseId/grades"),
    element: (
      <ProtectedRoute>
        <GradesPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <AlertProvider>
        <RouterProvider router={router} />
      </AlertProvider>
    </AuthProvider>
  </React.StrictMode>,
);
