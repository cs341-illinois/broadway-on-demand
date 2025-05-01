import { useState, useEffect } from "react";
import AppNavbar from "../components/Navbar";
import { Button, Container, Spinner } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { formulateUrl, getCourseRoles } from "../utils";
import { useNavigate, useParams } from "react-router-dom";
import { AssignmentInformationResponse, assignmentsResponseEntry, CourseInformationResponse } from "../../types/assignment";
import { useAlert } from "../contexts/AlertContext";
import AssignmentModal from "../components/CreateAssignmentModal";
import { z } from "zod";

async function getAssignmentData(courseId: string, assignmentId: string) {
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}`),
  );
  return (await response.json()) as AssignmentInformationResponse;
}

async function getAssignmentConfig(courseId: string, assignmentId: string) {
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}`),
  );
  const data = await response.json() as CourseInformationResponse;
  return data['assignments'].filter(x => x.id === assignmentId)[0] as z.infer<typeof assignmentsResponseEntry>;
}

export default function AssignmentHomePage() {
  const { user } = useAuth();
  const { courseId, assignmentId } = useParams();
  const [assignmentData, setAssignmentData] =
    useState<AssignmentInformationResponse | null>(null);
  const [manageAssignmentModal, setManageAssignmentModal] = useState<boolean>(false);
  const [assignmentConfig, setAssignmentConfig] = useState<null | CourseInformationResponse['assignments'][0]>(null);
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
  const courseRoles = getCourseRoles(courseId, user!.roles);
  useEffect(() => {
    (async () => {
      setAssignmentData(await getAssignmentData(courseId, assignmentId));
    })();
  }, []);
  useEffect(() => {
    (async () => {
      setAssignmentConfig(await getAssignmentConfig(courseId, assignmentId));
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
          {courseRoles.includes("ADMIN") && (
            <Button onClick={() => { setManageAssignmentModal(true) }}>
              Manage
            </Button>
          )}
          <p className="text-muted">
            All timestamps shown in your local timezone (
            {Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
        </Container>
      </div>
      {(courseRoles.includes("ADMIN") && assignmentConfig) && (
        <AssignmentModal
          show={Boolean(manageAssignmentModal)}
          handleClose={() => setManageAssignmentModal(false)}
          handleSubmit={() => { }}
          initialState={assignmentConfig}
        />
      )}
    </>
  );
}
