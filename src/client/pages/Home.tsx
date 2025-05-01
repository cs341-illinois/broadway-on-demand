import { useState, useEffect } from "react";
import AppNavbar from "../components/Navbar";
import { Container, Card, Button } from "react-bootstrap";
import { useNavigate } from "react-router-dom";
import { formulateUrl } from "../utils";
import { useAuth } from "../contexts/AuthContext";

export default function HomePage() {
  const navigate = useNavigate();
  const auth = useAuth();
  if (auth.isAuthenticated) {
    navigate(formulateUrl("dashboard"));
    return null;
  }
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNavbar />
      <Container className="d-flex justify-content-center align-items-center flex-grow-1">
        <Card className="p-4">
          <Card.Body>
            <h4 className="card-title">Welcome to Broadway On-Demand</h4>
            <Button
              variant="primary"
              onClick={() =>
                (window.location.href = formulateUrl("login/entra"))
              }
            >
              Log In
            </Button>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
