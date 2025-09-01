import { Navbar, Container, Nav, NavDropdown, Spinner } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext"; // adjust path as needed
import { formulateUrl } from "../utils";
import AppBreadcrumb, { AppBreadcrumbProps } from "./AppBreadcrumb";

export default function AppNavbar({
  title,
  breadcrumb,
}: {
  title?: string;
  breadcrumb?: AppBreadcrumbProps;
}) {
  const {
    isAuthenticated,
    isLoading: authIsLoading,
    user,
    logout: authLogout,
  } = useAuth();
  const logout = () => {
    window.sessionStorage.removeItem("courseInfo");
    authLogout();
  };
  return (
    <>
      {import.meta.env.DEV && <div style={{ backgroundColor: "green", color: "white" }}><Container>DEVELOPMENT SERVER</Container></div>}
      <Navbar expand="lg" className="bg-dark" variant="dark">
        <Container>
          <Navbar.Brand href={formulateUrl("dashboard")} className="text-white">
            {title || "Broadway On Demand"}
          </Navbar.Brand>
          <Navbar.Toggle aria-controls="basic-navbar-nav" />
          <Navbar.Collapse id="basic-navbar-nav">
            <Nav className="ms-auto">
              {authIsLoading && (
                <Spinner animation="border" variant="light" size="sm" />
              )}
              {!authIsLoading && isAuthenticated && user && (
                <NavDropdown
                  title={<span>{user.displayName || user.email}</span>}
                  id="user-nav-dropdown"
                  align="end"
                >
                  <NavDropdown.Item disabled>
                    Signed in as <strong>{user.email}</strong>
                  </NavDropdown.Item>
                  <NavDropdown.Divider />
                  <NavDropdown.Item onClick={logout}>Logout</NavDropdown.Item>
                </NavDropdown>
              )}
            </Nav>
          </Navbar.Collapse>
        </Container>
      </Navbar>
      {breadcrumb ? <AppBreadcrumb {...breadcrumb} /> : null}
    </>
  );
}
