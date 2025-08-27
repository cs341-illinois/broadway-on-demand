import { useState, useEffect, Suspense, useMemo } from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Table,
  Anchor,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";
import moment from "moment-timezone";
import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
  dateTimeFormatString,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import AssignmentModal from "../components/CreateAssignmentModal";
import {
  AssignmentQuotaLabels,
  CourseInformationResponse,
  CreateAssignmentBody,
} from "../../types/assignment";
import { AssignmentQuota, AssignmentVisibility } from "../enums";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";

async function getCourseData(
  courseId: string,
): Promise<CourseInformationResponse> {
  if (!courseId) {
    throw new Error("Course ID is missing. Cannot fetch course data.");
  }
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  if (!response.ok) {
    let errorMessage = `Failed to fetch course data. Status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.detail || errorMessage;
    } catch (e) {}
    throw new Error(errorMessage);
  }
  return (await response.json()) as CourseInformationResponse;
}

interface CourseContentProps {
  courseResource: Resource<CourseInformationResponse>;
  courseId: string;
  isStaff: boolean;
  courseRoles: string[];
  onShowAssignmentModal: () => void;
  navigate: ReturnType<typeof useNavigate>;
}

function CourseContent({
  courseResource,
  courseId,
  isStaff,
  courseRoles,
  onShowAssignmentModal,
  navigate,
}: CourseContentProps) {
  const courseData = courseResource.read();

  const getRowClass = (
    assignment: CourseInformationResponse["assignments"][0],
  ): string => {
    const now = new Date();
    const openDate = new Date(assignment.openAt);
    const dueDate = new Date(assignment.dueAt);

    switch (assignment.visibility as unknown as AssignmentVisibility) {
      case AssignmentVisibility.FORCE_OPEN:
        return "";
      case AssignmentVisibility.FORCE_CLOSE:
      case AssignmentVisibility.INVISIBLE_FORCE_CLOSE:
        return "table-secondary";
      case AssignmentVisibility.DEFAULT:
        if (now < openDate || now > dueDate) {
          return "table-secondary";
        }
        return "";
      default:
        return "";
    }
  };

  return (
    <>
      <AppNavbar
        title={courseData.name}
        breadcrumb={{ items: [{ label: "Course Home" }] }}
      />
      <Container className="p-2 flex-grow-1">
        <Row>
          <Col md={8} xs={12}>
            <h2>Assignments</h2>
            {courseData.assignments.length === 0 && (
              <p>No assignments found.</p>
            )}
            {courseData.assignments.length > 0 && (
              <Table hover responsive>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Runs</th>
                    <th>Open At</th>
                    <th>Due At</th>
                  </tr>
                </thead>
                <tbody>
                  {courseData.assignments.map((x) => (
                    <tr key={x.id} className={getRowClass(x)}>
                      <td>
                        <Anchor
                          href={formulateUrl(
                            `dashboard/${courseId}/assignment/${x.id}`,
                          )}
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
                      <td>
                        {moment(x.openAt).format(dateTimeFormatString)}
                        <p className="text-muted">
                          {moment(x.openAt).fromNow()}
                        </p>
                      </td>
                      <td>
                        {moment(x.dueAt).format(dateTimeFormatString)}
                        <p className="text-muted">
                          {moment(x.dueAt).fromNow()}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Col>
          <Col md={4} xs={12}>
            <Card>
              <Card.Header as="h5" className="ms-0">
                Actions
              </Card.Header>
              <Card.Body>
                <Row className="g-2">
                  <Col xs={12} sm={6}>
                    <Button
                      onClick={() =>
                        navigate(formulateUrl(`dashboard/${courseId}/grades`))
                      }
                      className="w-100"
                    >
                      View Grades
                    </Button>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Button
                      className="w-100"
                      onClick={() =>
                        navigate(
                          formulateUrl(`dashboard/${courseId}/selfExtension`),
                        )
                      }
                    >
                      Apply Extension
                    </Button>
                  </Col>
                  {isStaff && (
                    <>
                      <hr className="w-100 my-2" />
                      <Col xs={12} sm={6}>
                        <Button
                          onClick={() =>
                            navigate(
                              formulateUrl(`dashboard/${courseId}/roster`),
                            )
                          }
                          className="w-100"
                        >
                          Manage Roster
                        </Button>
                      </Col>
                      <Col xs={12} sm={6}>
                        <Button
                          onClick={() =>
                            navigate(
                              formulateUrl(`dashboard/${courseId}/studentInfo`),
                            )
                          }
                          className="w-100"
                        >
                          View Student
                        </Button>
                      </Col>
                      <Col xs={12} sm={12}>
                        <Button
                          onClick={() =>
                            navigate(
                              formulateUrl(`dashboard/${courseId}/attendance`),
                            )
                          }
                          className="w-100"
                        >
                          Take Attendance
                        </Button>
                        <hr />
                      </Col>
                    </>
                  )}
                  {courseRoles.includes("ADMIN") && (
                    <>
                      <Col xs={12} sm={12}>
                        <Button
                          onClick={() =>
                            navigate(
                              formulateUrl(
                                `dashboard/${courseId}/assignmentGrades`,
                              ),
                            )
                          }
                          className="w-100"
                        >
                          Manage Assignment Grades
                        </Button>
                      </Col>
                      <Col xs={12} sm={12}>
                        <Button
                          onClick={onShowAssignmentModal}
                          className="w-100"
                        >
                          Add Assignment
                        </Button>
                      </Col>
                    </>
                  )}
                </Row>
              </Card.Body>
            </Card>
          </Col>
        </Row>
        <Row>
          <p className="text-muted mt-3">
            All timestamps shown in your local timezone ({getTimeZoneName()}).
          </p>
        </Row>
      </Container>
    </>
  );
}

export default function CourseHomePage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const [assignmentModal, setAssignmentModal] = useState<boolean>(false);
  const [resourceKey, setResourceKey] = useState<number>(0);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  const isStaff = useMemo(() => {
    return courseRoles.includes("ADMIN") || courseRoles.includes("STAFF");
  }, [courseRoles]);

  useEffect(() => {
    if (!user) return;

    if (!courseId || courseRoles.length === 0) {
      showAlert("The specified course does not exist.", "danger");
      navigate(formulateUrl("dashboard"));
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = courseInfo.courseName;
  }, [courseId, user, courseRoles, navigate, showAlert]);
  const courseResource = useMemo<Resource<CourseInformationResponse>>(() => {
    return createResource<CourseInformationResponse>(() =>
      getCourseData(courseId),
    );
  }, [courseId, user?.id, resourceKey]);

  const handleAssignmentSubmit = async (
    data: CreateAssignmentBody,
  ): Promise<void> => {
    if (!courseId) {
      showAlert("Course ID is missing.", "danger");
      return;
    }
    try {
      await fetch(formulateUrl(`api/v1/courses/${courseId}/assignment`), {
        method: "POST",
        body: JSON.stringify(data),
        headers: { "Content-Type": "application/json" },
      });
      setResourceKey((prevKey) => prevKey + 1);
      showAlert("Assignment created!", "success");
      setAssignmentModal(false);
    } catch (e: unknown) {
      console.error("Failed to create assignment:", e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      showAlert(
        `Error creating assignment: ${JSON.parse(errorMessage).message}`,
        "danger",
      );
    }
  };

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }

  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <CourseContent
            courseResource={courseResource}
            courseId={courseId}
            isStaff={isStaff}
            courseRoles={courseRoles}
            onShowAssignmentModal={() => setAssignmentModal(true)}
            navigate={navigate}
          />
        </Suspense>
      </ErrorBoundary>

      {courseRoles.includes("ADMIN") && assignmentModal && (
        <AssignmentModal
          show={assignmentModal}
          handleClose={() => setAssignmentModal(false)}
          handleSubmit={handleAssignmentSubmit}
        />
      )}
    </>
  );
}
