import { Navbar, Container, Nav, NavDropdown, Spinner } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext"; // adjust path as needed
import { formulateUrl } from "../utils";

export default function AppNavbar() {
  const { isAuthenticated, isLoading, user, logout } = useAuth();
  return (
    <Navbar expand="lg" className="bg-dark">
      <Container>
        <Navbar.Brand href={formulateUrl("dashboard")} className="text-white">
          Broadway On-Demand
        </Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        <Navbar.Collapse id="basic-navbar-nav">
          <Nav className="ms-auto">
            {isLoading && (
              <Spinner animation="border" variant="light" size="sm" />
            )}
            {!isLoading && isAuthenticated && user && (
              <NavDropdown
                title={
                  <span className="text-white">
                    {user.displayName || user.email}
                  </span>
                }
                id="user-nav-dropdown"
                align="end"
                className="text-white"
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
  );
}
