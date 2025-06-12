import "./custom.scss";
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
import ManageAssignmentPage from "./pages/ManageAssignmentPage";
import CourseRosterPage from "./pages/Roster";
import SelfExtensionsPage from "./pages/SelfExtensionPage";
import StudentInfoPage from "./pages/StudentInfoPage";
import LabAttendancePage from "./pages/LabAttendancePage";
import { RouterErrorBoundaryWrapper } from "./components/RouterErrorBoundaryWrapper";
import AssignmentGradesPage from "./pages/AssignmentGrades";
const router = createBrowserRouter([
  {
    path: formulateUrl("/"),
    element: <HomePage />,
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard"),
    element: (
      <ProtectedRoute>
        <React.Suspense>
          <DashboardPage />
        </React.Suspense>
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId"),
    element: (
      <ProtectedRoute>
        <CourseHomePage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/selfExtension"),
    element: (
      <ProtectedRoute>
        <SelfExtensionsPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/assignment/:assignmentId"),
    element: (
      <ProtectedRoute>
        <AssignmentHomePage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/assignment/:assignmentId/manage"),
    element: (
      <ProtectedRoute>
        <ManageAssignmentPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/grades"),
    element: (
      <ProtectedRoute>
        <GradesPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/roster"),
    element: (
      <ProtectedRoute>
        <CourseRosterPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/studentInfo"),
    element: (
      <ProtectedRoute>
        <StudentInfoPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/assignmentGrades"),
    element: (
      <ProtectedRoute>
        <AssignmentGradesPage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: formulateUrl("dashboard/:courseId/attendance"),
    element: (
      <ProtectedRoute>
        <LabAttendancePage />
      </ProtectedRoute>
    ),
    errorElement: <RouterErrorBoundaryWrapper />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
    errorElement: <RouterErrorBoundaryWrapper />,
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
