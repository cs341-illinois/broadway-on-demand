import { Component, ErrorInfo, ReactNode } from "react";
import { Alert, Container } from "react-bootstrap";
import AppNavbar from "./Navbar";

interface ErrorBoundaryProps {
  children?: ReactNode;
  routerError?: unknown;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "ErrorBoundary (class) caught an error from children:",
      error,
      errorInfo,
    );
    this.setState({ errorInfo });
  }

  render() {
    const { children, routerError } = this.props;
    const {
      hasError: stateHasError,
      error: stateError,
      errorInfo: stateErrorInfo,
    } = this.state;

    if (routerError !== undefined) {
      let message = "An unexpected error occurred.";
      let details: string | undefined = undefined;

      if (routerError instanceof Error) {
        message = routerError.message || routerError.toString();
        details = routerError.stack;
      } else if (routerError && typeof routerError === "object") {
        const errObj = routerError as any;
        message = errObj.statusText || errObj.message || "An error occurred.";
        if (errObj.data) {
          details =
            typeof errObj.data === "string"
              ? errObj.data
              : JSON.stringify(errObj.data, null, 2);
        } else if (errObj.stack) {
          details = errObj.stack;
        }
      } else if (typeof routerError === "string") {
        message = routerError;
      }
      const data = JSON.parse(
        window.sessionStorage.getItem("courseInfo") || "{}",
      );
      return (
        <>
          <AppNavbar title={data.courseName} />
          <Container className="pt-3">
            <Alert variant="danger">
              <Alert.Heading>Oops! Something Went Wrong</Alert.Heading>
              <p>{message}</p>
              {details && (
                <details style={{ whiteSpace: "pre-wrap" }}>{details}</details>
              )}
              <hr />
              <p className="mb-0">
                Please try refreshing the page, or contact course staff if the
                problem persists.
              </p>
            </Alert>
          </Container>
        </>
      );
    }

    if (stateHasError) {
      return (
        <Container className="pt-3">
          <Alert variant="danger">
            <Alert.Heading>Oops! Something Went Wrong</Alert.Heading>
            <p>{stateError?.toString()}</p>
            {stateErrorInfo?.componentStack && (
              <details style={{ whiteSpace: "pre-wrap" }}>
                {stateErrorInfo.componentStack}
              </details>
            )}
            <hr />
            <p className="mb-0">
              Please try refreshing the page, or contact course staff if the
              problem persists.
            </p>
          </Alert>
        </Container>
      );
    }

    return children || null;
  }
}
