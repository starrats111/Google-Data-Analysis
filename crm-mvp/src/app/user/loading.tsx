import { Spin } from "antd";

export default function UserLoading() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <Spin size="large" tip="加载中..." />
    </div>
  );
}
