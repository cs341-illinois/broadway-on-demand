import { useState, useEffect } from "react";
import AppNavbar from "../components/Navbar";
import { Container, Spinner } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { formulateUrl, getCourseRoles } from "../utils";
import { useNavigate, useParams } from "react-router-dom";
import { AssignmentInformationResponse } from "../../types/assignment";
import { useAlert } from "../contexts/AlertContext";

async function getAssignmentData(courseId: string, assignmentId: string) {
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}`),
  );
  return (await response.json()) as AssignmentInformationResponse;
}

export default function AssignmentHomePage() {
  const { user } = useAuth();
  const { courseId, assignmentId } = useParams();
  const [assignmentData, setAssignmentData] =
    useState<AssignmentInformationResponse | null>(null);
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  if (
    !courseId ||
    !assignmentId ||
    getCourseRoles(courseId, user!.roles).length === 0
  ) {
    navigate(formulateUrl("dashboard"));
    return null;
  }
  useEffect(() => {
    (async () => {
      setAssignmentData(await getAssignmentData(courseId, assignmentId));
    })();
  }, []);
  if (!assignmentData) {
    return (
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <AppNavbar />
        <Container>
          <Spinner />
        </Container>
      </div>
    );
  }
  return (
    <>
      <AppNavbar />
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <Container className="p-2">
          <h1>{assignmentData.courseName}</h1>
          <h2>{assignmentData.assignmentName}</h2>
          <p className="text-muted">
            All timestamps shown in your local timezone (
            {Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
        </Container>
      </div>
    </>
  );
}
