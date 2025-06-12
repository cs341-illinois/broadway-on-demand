import { useRouteError } from "react-router-dom";
import { ErrorBoundary as ClassErrorBoundary } from "./ErrorBoundary"; // Adjust path if needed

export function RouterErrorBoundaryWrapper() {
  const error = useRouteError(); // Hook to get the error from React Router
  return <ClassErrorBoundary routerError={error} />;
}
