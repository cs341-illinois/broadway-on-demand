import { useEffect, useMemo, useState, Suspense } from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Table,
  Modal,
  Form,
  Badge,
  Spinner,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
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
import { CourseInformationResponse } from "../../types/assignment";
import { Role } from "../enums";
import {
  PartnerGroupEntry,
  PartnersForPeriodResponse,
} from "../../types/partners";

interface PartnersPageData {
  courseDetails: CourseInformationResponse;
  periodIndex: number;
  partners: PartnersForPeriodResponse;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(formulateUrl(url), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

async function getPartnersPageData(courseId: string): Promise<PartnersPageData> {
  const [courseDetails, { periodIndex }] = await Promise.all([
    fetchJson<CourseInformationResponse>(`api/v1/courses/${courseId}`),
    fetchJson<{ periodIndex: number }>(
      `api/v1/partners/${courseId}/currentPeriod`,
    ),
  ]);
  const partners = await fetchJson<PartnersForPeriodResponse>(
    `api/v1/partners/${courseId}/period/${periodIndex}`,
  );
  return { courseDetails, periodIndex, partners };
}

function groupsBySection(groups: PartnerGroupEntry[]) {
  const bySection = new Map<string, PartnerGroupEntry[]>();
  for (const group of groups) {
    const list = bySection.get(group.labSection) ?? [];
    list.push(group);
    bySection.set(group.labSection, list);
  }
  return bySection;
}

function groupsToTextarea(groups: PartnerGroupEntry[]) {
  return groups
    .map((g) => g.members.map((m) => m.netId).join(", "))
    .join("\n");
}

function memberLabel(member: { netId: string; name: string | null }) {
  return member.name ? `${member.name} (${member.netId})` : member.netId;
}

function parseTextareaToGroups(text: string): string[][] {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(",")
        .map((netId) => netId.trim())
        .filter(Boolean),
    )
    .filter((group) => group.length > 0);
}

interface ContentProps {
  resource: Resource<PartnersPageData>;
  courseId: string;
  isAdmin: boolean;
  isStaffOrAdmin: boolean;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
  refresh: () => void;
}

function PartnersContent({
  resource,
  courseId,
  isAdmin,
  showAlert,
  refresh,
}: ContentProps) {
  const { courseDetails, periodIndex, partners } = resource.read();
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const bySection = useMemo(
    () => groupsBySection(partners.groups),
    [partners.groups],
  );
  const sections = useMemo(
    () => [...new Set([...partners.sections, ...bySection.keys()])].sort(),
    [partners.sections, bySection],
  );

  const openEditModal = (labSection: string) => {
    setEditingSection(labSection);
    setEditingText(groupsToTextarea(bySection.get(labSection) ?? []));
  };

  const handleSaveSection = async () => {
    if (!editingSection) return;
    const groups = parseTextareaToGroups(editingText);
    if (groups.length === 0) {
      showAlert("You must specify at least one group.", "warning");
      return;
    }
    setIsSaving(true);
    try {
      await fetchJson(
        `api/v1/partners/${courseId}/period/${periodIndex}/section`,
        {
          method: "PUT",
          body: JSON.stringify({ labSection: editingSection, groups }),
        },
      );
      showAlert(`Saved groups for section ${editingSection}.`, "success");
      setEditingSection(null);
      refresh();
    } catch (error) {
      showAlert((error as Error).message || "Failed to save groups.", "danger");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRegenerate = async (labSection: string) => {
    if (
      !window.confirm(
        `Re-randomize all pairings for section ${labSection}, period ${periodIndex}? This discards the current pairings for that section.`,
      )
    ) {
      return;
    }
    try {
      await fetchJson(
        `api/v1/partners/${courseId}/period/${periodIndex}/section/regenerate`,
        {
          method: "POST",
          body: JSON.stringify({ labSection }),
        },
      );
      showAlert(`Regenerated groups for section ${labSection}.`, "success");
      refresh();
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to regenerate groups.",
        "danger",
      );
    }
  };

  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Lab Partners" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <Row className="mb-4 align-items-center">
          <Col>
            <h1>Lab Partners</h1>
            <p className="text-muted mb-0">
              Rotation period {periodIndex}. Pairings re-shuffle automatically
              every 4 weeks; edits below only affect this period.
            </p>
          </Col>
        </Row>

        {partners.ungroupedNetIds.length > 0 && (
          <Card bg="warning" text="dark" className="mb-4">
            <Card.Body>
              <strong>Ungrouped students ({partners.ungroupedNetIds.length}):</strong>{" "}
              {partners.ungroupedNetIds.join(", ")}
            </Card.Body>
          </Card>
        )}

        {sections.length === 0 && (
          <p className="text-muted">
            No lab sections found for this course yet. Run
            importLabSections.ts to import them.
          </p>
        )}

        {sections.map((labSection) => {
          const groups = bySection.get(labSection) ?? [];
          return (
            <Row className="mb-4" key={labSection}>
              <Col>
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <h3>Section {labSection}</h3>
                  {isAdmin && (
                    <div>
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        className="me-2"
                        onClick={() => openEditModal(labSection)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={() => handleRegenerate(labSection)}
                      >
                        Regenerate
                      </Button>
                    </div>
                  )}
                </div>
                <Card>
                  {groups.length > 0 ? (
                    <Table responsive striped bordered hover size="sm" className="mb-0">
                      <thead>
                        <tr>
                          <th>Members</th>
                          <th>Created By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((group) => (
                          <tr key={group.id}>
                            <td>
                              {group.members.map((member) => (
                                <Badge
                                  bg="secondary"
                                  className="me-1"
                                  key={member.netId}
                                >
                                  {memberLabel(member)}
                                </Badge>
                              ))}
                            </td>
                            <td>{group.createdBy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <Card.Body className="text-muted">
                      No groups yet for this section this period.
                      {isAdmin && ' Use "Edit" or "Regenerate" above to create them.'}
                    </Card.Body>
                  )}
                </Card>
              </Col>
            </Row>
          );
        })}

        <Modal show={editingSection !== null} onHide={() => !isSaving && setEditingSection(null)} size="lg">
          <Modal.Header closeButton={!isSaving}>
            <Modal.Title>Edit Section {editingSection}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className="text-muted">
              One group per line, netIds separated by commas (2-3 per group).
              This replaces every group in this section for period {periodIndex}.
            </p>
            <Form.Control
              as="textarea"
              rows={10}
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              disabled={isSaving}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setEditingSection(null)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSaveSection} disabled={isSaving}>
              {isSaving ? <Spinner as="span" size="sm" animation="border" /> : "Save"}
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </>
  );
}

interface MyPartnerGroupResponse {
  periodIndex: number;
  labSection: string | null;
  group: { id: string; members: { netId: string; name: string | null }[] } | null;
}

function StudentPartnersContent({
  resource,
  courseId,
  currentUserNetId,
}: {
  resource: Resource<{ courseDetails: CourseInformationResponse; me: MyPartnerGroupResponse }>;
  courseId: string;
  currentUserNetId: string | undefined;
}) {
  const { courseDetails, me } = resource.read();
  const partners = (me.group?.members ?? []).filter(
    (member) => member.netId !== currentUserNetId,
  );
  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Lab Partners" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <h1>My Lab Partner(s)</h1>
        <Card className="mt-3">
          <Card.Body>
            {me.labSection ? (
              <p>
                Lab section: <Badge bg="secondary">{me.labSection}</Badge>
              </p>
            ) : (
              <p className="text-muted">
                You aren't assigned to a lab section yet.
              </p>
            )}
            {me.group ? (
              partners.length > 0 ? (
                <p>
                  Your partner{partners.length > 1 ? "s" : ""} for this
                  rotation:{" "}
                  {partners.map((member) => (
                    <Badge bg="primary" className="me-1" key={member.netId}>
                      {memberLabel(member)}
                    </Badge>
                  ))}
                </p>
              ) : (
                <p className="text-muted">
                  You're in a group by yourself this rotation - no partner
                  assigned.
                </p>
              )
            ) : (
              <p className="text-muted">
                No partner group assigned yet for this rotation.
              </p>
            )}
          </Card.Body>
        </Card>
      </Container>
    </>
  );
}

export default function PartnersPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [resourceKey, setResourceKey] = useState(0);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);
  const isStaffOrAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );
  const isAdmin = useMemo(() => courseRoles.includes(Role.ADMIN), [courseRoles]);
  const currentUserNetId = useMemo(() => user?.email?.split("@")[0], [user]);

  useEffect(() => {
    if (!user) return;
    if (!courseId || courseRoles.length === 0) {
      showAlert("You do not have permission to view this page.", "danger");
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Lab Partners | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate, showAlert]);

  const staffResource = useMemo<Resource<PartnersPageData>>(() => {
    if (!courseId || !isStaffOrAdmin) {
      return createResource<PartnersPageData>(() =>
        Promise.reject(new Error("Access denied.")),
      );
    }
    return createResource<PartnersPageData>(() => getPartnersPageData(courseId));
  }, [courseId, isStaffOrAdmin, resourceKey]);

  const studentResource = useMemo<
    Resource<{ courseDetails: CourseInformationResponse; me: MyPartnerGroupResponse }>
  >(() => {
    if (!courseId || isStaffOrAdmin) {
      return createResource(() => Promise.reject(new Error("Access denied.")));
    }
    return createResource(async () => {
      const [courseDetails, me] = await Promise.all([
        fetchJson<CourseInformationResponse>(`api/v1/courses/${courseId}`),
        fetchJson<MyPartnerGroupResponse>(`api/v1/partners/${courseId}/me`),
      ]);
      return { courseDetails, me };
    });
  }, [courseId, isStaffOrAdmin, resourceKey]);

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }
  if (!courseId || courseRoles.length === 0) {
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          {isStaffOrAdmin ? (
            <PartnersContent
              resource={staffResource}
              courseId={courseId}
              isAdmin={isAdmin}
              isStaffOrAdmin={isStaffOrAdmin}
              showAlert={showAlert}
              refresh={() => setResourceKey((k) => k + 1)}
            />
          ) : (
            <StudentPartnersContent
              resource={studentResource}
              courseId={courseId}
              currentUserNetId={currentUserNetId}
            />
          )}
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
