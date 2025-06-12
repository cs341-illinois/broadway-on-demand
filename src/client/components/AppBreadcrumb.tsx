import { Container } from "react-bootstrap";
import Breadcrumb from "react-bootstrap/Breadcrumb";

export type AppBreadcrumbProps = {
  items: { label: string; href?: string }[];
};
export const AppBreadcrumb = ({ items }: AppBreadcrumbProps) => {
  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div style={{ background: "var(--il-storm-lighter-4)" }}>
      <Container className="d-flex flex-grow-1">
        <Breadcrumb
          listProps={{ className: "mb-0 pt-2 pb-2" }}
          style={{ color: "var(--il-storm-darker-2)" }}
        >
          {items.map((item, index) => (
            <Breadcrumb.Item
              key={index}
              href={index === items.length - 1 ? undefined : item.href}
              active={index === items.length - 1}
              className="d-flex align-items-center"
            >
              {item.label}
            </Breadcrumb.Item>
          ))}
        </Breadcrumb>
      </Container>
    </div>
  );
};

export default AppBreadcrumb;
