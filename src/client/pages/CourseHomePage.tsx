import { useState, useEffect } from "react";
import AppNavbar from "../components/Navbar";
import {
  Container,
  Card,
  Button,
  Spinner,
  Row,
  Col,
  Table,
  Anchor,
} from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { formulateUrl, getCourseRoles } from "../utils";
import { useNavigate, useParams } from "react-router-dom";
import AssignmentModal from "../components/CreateAssignmentModal";
import {
  AssignmentQuota,
  AssignmentQuotaLabels,
  CourseInformationResponse,
  CreateAssignmentBody,
} from "../../types/assignment";
import { useAlert } from "../contexts/AlertContext";

async function getCourseData(courseId: string) {
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  return (await response.json()) as CourseInformationResponse;
}

export default function CourseHomePage() {
  const { user } = useAuth();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const [courseData, setCourseData] =
    useState<CourseInformationResponse | null>(null);
  const [assignmentModal, setAssignmentModal] = useState(false);

  if (!courseId || getCourseRoles(courseId, user!.roles).length === 0) {
    navigate(formulateUrl("dashboard"));
    return null;
  }
  useEffect(() => {
    (async () => {
      const data = await getCourseData(courseId);
      setCourseData(data);
    })();
  }, []);
  const courseRoles = getCourseRoles(courseId, user!.roles);
  const handleAssignmentSubmit = async (data: CreateAssignmentBody) => {
    try {
      await fetch(formulateUrl(`api/v1/courses/${courseId}/assignment`), {
        method: "POST",
        body: JSON.stringify(data),
        headers: { "Content-Type": "application/json" },
      });
      const newData = await getCourseData(courseId);
      setCourseData(newData);
      showAlert("Assignment created!", "success");
    } catch (e) {
      showAlert(
        "Something went wrong creating the assignment. Please try again.",
        "danger",
      );
      throw e;
    }
  };
  if (!courseData) {
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
          <h1>{courseData.name}</h1>
          <p className="text-muted">
            All timestamps shown in your local timezone (
            {Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
          <Row className="pt-3">
            <Col md={8} xs={12}>
              <h3>Assignments</h3>
              {courseData.assignments.length === 0 && (
                <p>No assignments found.</p>
              )}
              {courseData.assignments.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Runs</th>
                      <th>Opens At</th>
                      <th>Due At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {courseData.assignments.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <Anchor
                            href={formulateUrl(`dashboard/${courseId}/${x.id}`)}
                          >
                            {x.name}
                          </Anchor>
                        </td>
                        <td>
                          {x.quotaAmount}{" "}
                          {
                            AssignmentQuotaLabels[
                              x.quotaPeriod as AssignmentQuota
                            ]
                          }
                        </td>
                        <td>{new Date(x.openAt).toLocaleString()}</td>
                        <td>{new Date(x.dueAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Col>
            <Col md={4} xs={12}>
              <Card>
                <Card.Title className="m-3">Actions</Card.Title>
                <Card.Body>
                  <Row className="mb-2">
                    <Col xs={12} sm={6} className="mb-2">
                      <Button
                        onClick={() =>
                          navigate(formulateUrl(`dashboard/${courseId}/grades`))
                        }
                        className="w-100"
                      >
                        View Grades
                      </Button>
                    </Col>
                    <Col xs={12} sm={6} className="mb-2">
                      <Button className="w-100">Apply Extension</Button>
                    </Col>

                    {courseRoles.includes("ADMIN") && (
                      <>
                        <Col xs={12} sm={6} className="mb-2">
                          <Button className="w-100">Worker Status</Button>
                        </Col>
                        <Col xs={12} sm={6} className="mb-2">
                          <Button
                            onClick={() => setAssignmentModal(true)}
                            className="w-100"
                          >
                            Add Assignment
                          </Button>
                        </Col>
                        <Col xs={12} sm={6} className="mb-2">
                          <Button className="w-100">Modify Roster</Button>
                        </Col>
                      </>
                    )}
                  </Row>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
      {}
      {courseRoles.includes("ADMIN") && (
        <AssignmentModal
          show={assignmentModal}
          handleClose={() => setAssignmentModal(false)}
          handleSubmit={handleAssignmentSubmit}
        />
      )}
    </>
  );
}
