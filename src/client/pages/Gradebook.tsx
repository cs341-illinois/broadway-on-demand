import { useEffect, Suspense, useMemo, useState } from "react";
import { Container, Table, ProgressBar, Alert, Badge, Form, Button } from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import {
  createResource,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";

import { GradebookResponse, calculateFinalGrade } from "../../types/gradebook";
import { CategoryLabels } from "../../types/assignment";
import { useAlert } from "../contexts/AlertContext";

interface CourseDetails {
  name: string;
  [key: string]: any;
}

interface GradebookPageData {
  courseDetails: CourseDetails;
  gradebook: GradebookResponse;
}

async function fetchCourseDetailsInternal(courseId: string): Promise<CourseDetails> {
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  if (!response.ok) {
    throw new Error(`Failed to fetch course details. Status: ${response.status}`);
  }
  return (await response.json()) as CourseDetails;
}

async function fetchGradebookInternal(courseId: string): Promise<GradebookResponse> {
  const response = await fetch(formulateUrl(`api/v1/gradebook/${courseId}`));
  if (!response.ok) {
    throw new Error(`Failed to fetch gradebook. Status: ${response.status}`);
  }
  return (await response.json()) as GradebookResponse;
}

async function getGradebookPageData(courseId: string): Promise<GradebookPageData> {
  const [courseDetails, gradebook] = await Promise.all([
    fetchCourseDetailsInternal(courseId),
    fetchGradebookInternal(courseId),
  ]);
  return { courseDetails, gradebook };
}

function formatGrade(grade: number | null): string {
  return grade === null ? "Not yet available" : `${grade.toFixed(2)}%`;
}

interface GradebookContentProps {
  gradebookPageResource: Resource<GradebookPageData>;
  courseId: string;
}

function GradebookContent({ gradebookPageResource, courseId }: GradebookContentProps) {
  const { courseDetails, gradebook } = gradebookPageResource.read();
  const [whatIfMode, setWhatIfMode] = useState(false);
  const [whatIfScores, setWhatIfScores] = useState<Record<string, number>>({});

  const realGrade = gradebook.currentGrade;

  const projectedGrade = useMemo(() => {
    if (!whatIfMode) return null;
    const assignmentsWithOverrides = gradebook.assignments.map((a) => ({
      id: a.id,
      category: a.category,
      weight: a.weight,
      score: a.id in whatIfScores ? whatIfScores[a.id] : a.score,
    }));
    return calculateFinalGrade(assignmentsWithOverrides, gradebook.categoryConfigs).finalGrade;
  }, [whatIfMode, whatIfScores, gradebook]);

  const hasOverrides = Object.keys(whatIfScores).length > 0;

  return (
    <>
      <AppNavbar
        title={courseDetails.name}
        breadcrumb={{
          items: [
            { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
            { label: "Gradebook" },
          ],
        }}
      />
      <Container className="p-2 flex-grow-1">
        <h2>Gradebook</h2>
        <p className="text-muted">
          Your calculated final grade based on published scores so far.
        </p>

        <div className="mb-3">
          <h4>Current Grade: {formatGrade(realGrade)}</h4>
          {realGrade !== null && (
            <ProgressBar now={Math.min(realGrade, 100)} label={`${realGrade.toFixed(1)}%`} />
          )}
        </div>

        <Form.Check
          type="switch"
          id="what-if-mode-switch"
          label="What-If Mode"
          checked={whatIfMode}
          onChange={(e) => setWhatIfMode(e.target.checked)}
          className="mb-3"
        />

        {whatIfMode && (
          <Alert variant="warning">
            <b>⚠ Hypothetical projection — not your real grade.</b> Edit the
            "What-If Score" column below to see how different scores would
            affect your final grade. These values are not saved and reset
            when you reload the page.
            <div className="mt-2">
              <b>Projected Grade: {formatGrade(projectedGrade)}</b>
            </div>
            {hasOverrides && (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => setWhatIfScores({})}
                >
                  Reset What-If Scores
                </Button>
              </div>
            )}
          </Alert>
        )}

        <Table striped bordered hover responsive size="sm">
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Category</th>
              <th>Weight</th>
              <th>Score</th>
              {whatIfMode && <th>What-If Score</th>}
              <th>Comments</th>
            </tr>
          </thead>
          <tbody>
            {gradebook.assignments.map((a) => {
              const hasOverride = a.id in whatIfScores;
              return (
                <tr key={a.id} className={hasOverride ? "table-warning" : undefined}>
                  <td>
                    {a.name}
                    {hasOverride && (
                      <>
                        {" "}
                        <Badge bg="warning" text="dark">
                          What-If
                        </Badge>
                      </>
                    )}
                  </td>
                  <td>{CategoryLabels[a.category] || a.category}</td>
                  <td>{a.weight}</td>
                  <td>{a.score === null ? <span className="text-muted">Ungraded</span> : a.score}</td>
                  {whatIfMode && (
                    <td>
                      <Form.Control
                        type="number"
                        min={0}
                        size="sm"
                        value={hasOverride ? whatIfScores[a.id] : a.score ?? ""}
                        placeholder={a.score === null ? "Enter a score" : undefined}
                        onChange={(e) => {
                          const value = e.target.value === "" ? undefined : Number(e.target.value);
                          setWhatIfScores((prev) => {
                            const next = { ...prev };
                            if (value === undefined || Number.isNaN(value)) {
                              delete next[a.id];
                            } else {
                              next[a.id] = value;
                            }
                            return next;
                          });
                        }}
                      />
                    </td>
                  )}
                  <td>{a.comments}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Container>
    </>
  );
}

export default function GradebookPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  useEffect(() => {
    if (!user) return;

    if (!courseId || courseRoles.length === 0) {
      showAlert(
        "The specified course does not exist or you do not have access.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Gradebook | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate]);

  const gradebookPageResource = useMemo<Resource<GradebookPageData>>(() => {
    return createResource<GradebookPageData>(() => getGradebookPageData(courseId));
  }, [courseId, user?.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <GradebookContent gradebookPageResource={gradebookPageResource} courseId={courseId} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
