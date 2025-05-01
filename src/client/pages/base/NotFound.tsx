import { useState, useEffect } from "react";
import AppNavbar from "../../components/Navbar";
import { Container, Card, Button } from "react-bootstrap";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";

export default function NotFoundPage() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNavbar />
      <Container className="d-flex justify-content-center align-items-center flex-grow-1">
        <Card className="p-4">
          <Card.Body>
            <h4 className="card-title">Page Not Found</h4>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
