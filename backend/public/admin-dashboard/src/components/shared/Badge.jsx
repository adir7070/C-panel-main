const variants = {
  success: "bg-green-50 text-green-700 border-green-200",
  warning: "bg-yellow-50 text-yellow-700 border-yellow-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  info: "bg-blue-50 text-blue-700 border-blue-200",
  neutral: "bg-gray-50 text-gray-700 border-gray-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
};

export default function Badge({ children, variant = "neutral" }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${
        variants[variant] || variants.neutral
      }`}
    >
      {children}
    </span>
  );
}
