import { useState, useEffect, useTransition } from "react";
import AppNavbar from "../components/Navbar";
import { Container, Card, Button } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { CourseRolesTable } from "../components/CourseTable";
import { getCourseRoles } from "../utils";

export default function Dashboard() {
  const { user } = useAuth();
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNavbar />
      <Container>
        <CourseRolesTable roles={user!.roles} />
      </Container>
    </div>
  );
}
