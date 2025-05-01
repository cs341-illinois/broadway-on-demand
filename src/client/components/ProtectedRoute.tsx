import React, { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { formulateUrl } from "../utils";
import AppNavbar from "./Navbar";
import { Container, Spinner } from "react-bootstrap";

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: {
    courseId: string;
    role: string;
  };
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRole,
}) => {
  const { isAuthenticated, isLoading, hasRole } = useAuth();
  const location = useLocation();
  if (isLoading) {
    // You can replace this with a loading spinner
    return (
      <>
        <AppNavbar />
        <Container className="pt-4 pb-4">
          <Spinner className="pt-4 pb-4" />
        </Container>
      </>
    );
  }

  if (!isAuthenticated) {
    // Redirect to login page if not authenticated
    return (
      <Navigate
        to={formulateUrl(`?li=true&returnTo=${location.pathname}`)}
        state={{ from: location }}
        replace
      />
    );
  }

  // Check for required role if specified
  if (requiredRole && !hasRole(requiredRole.courseId, requiredRole.role)) {
    // Redirect to unauthorized page
    return <Navigate to={formulateUrl("dashboard")} replace />;
  }

  // If authenticated and has required role (if any), render children
  return <>{children}</>;
};
